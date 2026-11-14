import type { SpaceDatabaseRow, SpaceGroupBucket } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_PENDING_CELL_EDITS, type PendingCellEdits } from "./cellEdits.ts";
import { canonicalJson } from "./queryKey.ts";
import type { QuerySnapshot } from "./querySession.ts";
import { deriveViewRows } from "./viewRows.ts";

const row = (id: string, title = id): SpaceDatabaseRow =>
  ({ page: { id, title }, cells: { title } }) as never;
const source = "source" as never;
const key = { kind: "option", optionId: "a" } as never;

function snapshot(options: {
  rows?: ReadonlyArray<SpaceDatabaseRow>;
  groups?: ReadonlyArray<SpaceGroupBucket>;
  acked?: PendingCellEdits;
  placed?: QuerySnapshot["placed"];
}): QuerySnapshot {
  return {
    status: "ready",
    windows: {
      key: "k",
      rows: options.rows ?? [],
      nextCursor: null,
      groups: options.groups,
      groupsTruncated: false,
      total: undefined,
      schemaRevision: 1,
      dataRevision: 1,
      outdated: false,
    },
    aggregates: [],
    relatedPages: {},
    stale: false,
    loadingMore: false,
    loadingBuckets: new Set(),
    placed: options.placed ?? [],
    placements: {},
    acked: options.acked ?? EMPTY_PENDING_CELL_EDITS,
    error: undefined,
    loadError: undefined,
    computedPending: false,
  };
}

const edit = (pageId: string, value: string, dataSourceId = source, seq = 1) => ({
  dataSourceId,
  pageId: pageId as never,
  propertyId: "title" as never,
  value,
  seq,
});
const keyed = (value: ReturnType<typeof edit>): PendingCellEdits => ({
  [JSON.stringify([value.pageId, value.propertyId])]: value,
});

describe("deriveViewRows", () => {
  it("keeps row identities when nothing is pending", () => {
    const loaded = [row("a"), row("b")];
    const shown = snapshot({ rows: loaded });
    const first = deriveViewRows({
      mode: "rows",
      dataSourceId: source,
      snapshot: shown,
      writerPending: EMPTY_PENDING_CELL_EDITS,
    });
    expect(first.rows).toBe(loaded);
    expect(first.pending).toBe(EMPTY_PENDING_CELL_EDITS);
    expect(first.groups).toBeNull();
  });

  it("shows the writer's edits of this data source over loaded rows and ignores other sources", () => {
    const loaded = [row("a"), row("b")];
    const result = deriveViewRows({
      mode: "rows",
      dataSourceId: source,
      snapshot: snapshot({ rows: loaded }),
      writerPending: {
        ...keyed(edit("a", "new")),
        ...keyed(edit("b", "other", "elsewhere" as never)),
      },
    });
    expect(result.rows[0]?.cells["title"]).toBe("new");
    expect(result.rows[1]).toBe(loaded[1]);
  });

  it("puts acknowledged edits under newer queued ones", () => {
    const result = deriveViewRows({
      mode: "rows",
      dataSourceId: source,
      snapshot: snapshot({ rows: [row("a")], acked: keyed(edit("a", "acked", source, 1)) }),
      writerPending: keyed(edit("a", "queued", source, 2)),
    });
    expect(result.rows[0]?.cells["title"]).toBe("queued");
    const acked = deriveViewRows({
      mode: "rows",
      dataSourceId: source,
      snapshot: snapshot({ rows: [row("a")], acked: keyed(edit("a", "acked")) }),
      writerPending: EMPTY_PENDING_CELL_EDITS,
    });
    expect(acked.rows[0]?.cells["title"]).toBe("acked");
  });

  it("appends placed rows in rows mode only", () => {
    const placed = [{ row: row("p"), group: null }];
    const shown = snapshot({ rows: [row("a")], placed });
    const rows = deriveViewRows({
      mode: "rows",
      dataSourceId: source,
      snapshot: shown,
      writerPending: EMPTY_PENDING_CELL_EDITS,
    });
    expect(rows.rows.map((entry) => entry.page.id)).toEqual(["a", "p"]);
  });

  it("places rows into their bucket and counts them", () => {
    const bucket = { key, rows: [row("a")], count: 1, label: "A" } as never as SpaceGroupBucket;
    const other = {
      key: { kind: "empty" },
      rows: [row("c")],
      count: 1,
    } as never as SpaceGroupBucket;
    const result = deriveViewRows({
      mode: "groups",
      dataSourceId: source,
      snapshot: snapshot({
        groups: [bucket, other],
        placed: [{ row: row("p"), group: canonicalJson(bucket.key) }],
      }),
      writerPending: EMPTY_PENDING_CELL_EDITS,
    });
    expect(result.groups?.[0]?.rows.map((entry) => entry.page.id)).toEqual(["a", "p"]);
    expect(result.groups?.[0]?.count).toBe(2);
    expect(result.groups?.[1]).toBe(other);
    expect(result.rows).toEqual([]);
  });

  it("does not count a surviving placed card twice, nor show it beside its loaded copy", () => {
    const bucket = { key, rows: [row("a")], count: 30 } as never as SpaceGroupBucket;
    const group = canonicalJson(bucket.key);
    const survivor = deriveViewRows({
      mode: "groups",
      dataSourceId: source,
      snapshot: snapshot({
        groups: [bucket],
        placed: [{ row: row("p"), group, counted: true }],
      }),
      writerPending: EMPTY_PENDING_CELL_EDITS,
    });
    expect(survivor.groups?.[0]?.rows.map((entry) => entry.page.id)).toEqual(["a", "p"]);
    expect(survivor.groups?.[0]?.count).toBe(30);
    const loadedLater = deriveViewRows({
      mode: "groups",
      dataSourceId: source,
      snapshot: snapshot({
        groups: [{ ...bucket, rows: [row("a"), row("p")] } as never],
        placed: [{ row: row("p"), group, counted: true }],
      }),
      writerPending: EMPTY_PENDING_CELL_EDITS,
    });
    expect(loadedLater.groups?.[0]?.rows).toHaveLength(2);
  });

  it("keeps the rows of a grouped answer on screen while the view turns flat", () => {
    const a = { key, rows: [row("a")], count: 1 } as never as SpaceGroupBucket;
    const b = { key: { kind: "empty" }, rows: [row("b")], count: 1 } as never as SpaceGroupBucket;
    const result = deriveViewRows({
      mode: "rows",
      dataSourceId: source,
      snapshot: snapshot({ groups: [a, b] }),
      writerPending: EMPTY_PENDING_CELL_EDITS,
    });
    expect(result.rows.map((entry) => entry.page.id)).toEqual(["a", "b"]);
    expect(result.groups).toBeNull();
  });
});
