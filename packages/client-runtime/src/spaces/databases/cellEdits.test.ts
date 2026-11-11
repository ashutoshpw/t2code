import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceCursor,
  type SpaceDatabaseQueryInput,
  type SpaceDatabaseQueryResult,
  SpaceDataSourceId,
  SpacePageId,
  SpacePropertyId,
  type SpaceDatabaseRow,
} from "@t2code/contracts/spaces";

import {
  EMPTY_PENDING_CELL_EDITS,
  applyCellPatches,
  coalesceCellWrites,
  queueCellEdit,
  settleCellEdits,
  type PendingCellEdit,
} from "./cellEdits.ts";
import { queryKey } from "./queryKey.ts";
import { appendWindow, startWindows } from "./windows.ts";

const source = SpaceDataSourceId.make("source");
const otherSource = SpaceDataSourceId.make("other");
const pid = SpacePropertyId.make;
const page = SpacePageId.make;
const edit = (
  pageId: string,
  propertyId: string,
  value: PendingCellEdit["value"],
  seq: number,
  dataSourceId = source,
): PendingCellEdit => ({
  dataSourceId,
  pageId: page(pageId),
  propertyId: pid(propertyId),
  value,
  seq,
});
const row = (id: string, cells: SpaceDatabaseRow["cells"] = {}): SpaceDatabaseRow => ({
  page: { id: page(id), title: id, revision: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  number: 1,
  cells,
});
const queue = (...edits: PendingCellEdit[]) =>
  edits.reduce(queueCellEdit, EMPTY_PENDING_CELL_EDITS);

describe("optimistic cell edits", () => {
  it("overlays the newest edit per cell and clears on null", () => {
    const rows = [row("a", { x: 1, y: 2 }), row("b", { x: 3 })];
    const pending = queue(edit("a", "x", 5, 1), edit("a", "x", 6, 2), edit("a", "y", null, 3));
    const shown = applyCellPatches(rows, pending);
    expect(shown[0]?.cells).toEqual({ x: 6 });
    expect(shown[1]).toBe(rows[1]);
    expect(rows[0]?.cells).toEqual({ x: 1, y: 2 });
    expect(applyCellPatches(rows, EMPTY_PENDING_CELL_EDITS)).toBe(rows);
  });

  it("ignores an edit older than the queued one for the same cell", () => {
    const pending = queue(edit("a", "x", 2, 5), edit("a", "x", 1, 4));
    expect(Object.values(pending).map((entry) => entry.value)).toEqual([2]);
  });

  it("keeps an edit made while a batch was in flight and drops the settled ones", () => {
    const pending = queue(edit("a", "x", 1, 1), edit("a", "y", 2, 2));
    const [batch] = coalesceCellWrites(pending, {
      maxRowsPerMutation: 10,
      maxCellsPerMutation: 10,
    });
    const during = queueCellEdit(pending, edit("a", "x", 9, 3));
    const after = settleCellEdits(during, batch!.edits);
    expect(Object.values(after).map((entry) => [entry.propertyId, entry.value])).toEqual([
      ["x", 9],
    ]);
    expect(applyCellPatches([row("a", { x: 1 })], after)[0]?.cells).toEqual({ x: 9 });
    expect(settleCellEdits(after, [])).toBe(after);
  });

  it("coalesces per data source within the row and cell limits", () => {
    const pending = queue(
      edit("a", "x", 1, 1),
      edit("a", "y", 2, 2),
      edit("b", "x", 3, 3),
      edit("c", "x", 4, 4),
      edit("d", "x", 5, 5, otherSource),
    );
    const batches = coalesceCellWrites(pending, { maxRowsPerMutation: 2, maxCellsPerMutation: 3 });
    expect(batches.map((batch) => [batch.dataSourceId, batch.rows.map((r) => r.pageId)])).toEqual([
      [source, ["a", "b"]],
      [source, ["c"]],
      [otherSource, ["d"]],
    ]);
    expect(batches[0]?.rows[0]?.cells).toEqual({ x: 1, y: 2 });
    for (const batch of batches) {
      expect(batch.rows.length).toBeLessThanOrEqual(2);
      expect(batch.edits.length).toBeLessThanOrEqual(3);
    }
    expect(batches.flatMap((batch) => batch.edits)).toHaveLength(5);
  });

  it("splits a row that alone exceeds the cell limit", () => {
    const pending = queue(edit("a", "x", 1, 1), edit("a", "y", 2, 2), edit("a", "z", 3, 3));
    const batches = coalesceCellWrites(pending, { maxRowsPerMutation: 5, maxCellsPerMutation: 2 });
    expect(batches.map((batch) => batch.edits.length)).toEqual([2, 1]);
  });
});

describe("windowed query state", () => {
  const input = (over: Partial<SpaceDatabaseQueryInput> = {}): SpaceDatabaseQueryInput => ({
    environmentId: EnvironmentId.make("target"),
    dataSourceId: source,
    mode: "rows",
    timeZone: "UTC",
    ...over,
  });
  const result = (over: Partial<SpaceDatabaseQueryResult> = {}): SpaceDatabaseQueryResult => ({
    dataSourceId: source,
    schemaRevision: 1,
    dataRevision: 1,
    rows: [],
    nextCursor: null,
    relatedPages: {},
    ...over,
  });
  const cursor = SpaceCursor.make;

  it("keys a query without its cursor, independent of member order", () => {
    expect(queryKey(input({ cursor: cursor("c1") }))).toBe(queryKey(input()));
    expect(queryKey({ ...input(), search: "a", limit: 5 })).toBe(
      queryKey({ limit: 5, search: "a", ...input() }),
    );
    expect(queryKey(input({ search: "a" }))).not.toBe(queryKey(input({ search: "b" })));
  });

  it("appends windows, replaces re-read rows, and flags a moved data revision", () => {
    const first = startWindows(
      input(),
      result({ rows: [row("a"), row("b")], nextCursor: cursor("c1") }),
    );
    expect(first.outdated).toBe(false);
    const second = appendWindow(
      first,
      input({ cursor: cursor("c1") }),
      result({ rows: [row("b", { x: 1 }), row("c")], nextCursor: null }),
    );
    expect(second.rows.map((r) => r.page.id)).toEqual(["a", "b", "c"]);
    expect(second.rows[1]?.cells).toEqual({ x: 1 });
    expect(second.nextCursor).toBeNull();
    expect(second.outdated).toBe(false);
    const edited = appendWindow(
      first,
      input({ cursor: cursor("c1") }),
      result({ dataRevision: 2 }),
    );
    expect(edited.outdated).toBe(true);
    expect(appendWindow(first, input({ search: "z" }), result({ rows: [row("z")] }))).toBe(first);
  });

  it("continues one group bucket without touching the others", () => {
    const key = (kind: string) => ({ kind });
    const bucket = (name: string, ids: string[], next: string | null) => ({
      key: key(name),
      count: 5,
      rows: ids.map((id) => row(id)),
      nextCursor: next === null ? null : SpaceCursor.make(next),
    });
    const first = startWindows(
      input({ mode: "groups", rowsPerGroup: 1 }),
      result({ groups: [bucket("p", ["a"], "g1"), bucket("q", ["b"], null)] }),
    );
    const next = appendWindow(
      first,
      input({ mode: "groups", rowsPerGroup: 1 }),
      result({ groups: [bucket("p", ["a"], "g1"), bucket("q", ["b"], null)] }),
    );
    expect(next.groups).toHaveLength(2);
    const grown = appendWindow(
      first,
      input({ scope: { group: key("p") }, cursor: cursor("g1") }),
      result({ rows: [row("a2")], nextCursor: null }),
    );
    expect(grown.groups?.[0]?.rows.map((r) => r.page.id)).toEqual(["a", "a2"]);
    expect(grown.groups?.[0]?.nextCursor).toBeNull();
    expect(grown.groups?.[1]).toBe(first.groups?.[1]);
  });
});
