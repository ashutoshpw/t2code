import { describe, expect, it } from "vite-plus/test";
import type {
  SpaceCellMap,
  SpaceDataSourceId,
  SpacePageId,
  SpacePropertyId,
} from "@t2code/contracts/spaces";

import { queueCellEdit, type PendingCellEdit } from "./cellEdits.ts";
import { patchRowCells, recordAck } from "./rowCells.ts";

const page = "page-1" as SpacePageId;
const other = "page-2" as SpacePageId;
const source = "source-1" as SpaceDataSourceId;
const status = "p-status" as SpacePropertyId;

const edit = (value: PendingCellEdit["value"], seq: number, pageId = page): PendingCellEdit => ({
  dataSourceId: source,
  pageId,
  propertyId: status,
  value,
  seq,
});

const data = (cells: SpaceCellMap, dataRevision: number) =>
  ({ row: { page: { id: page }, cells }, dataSource: { dataRevision } }) as never;

describe("patchRowCells", () => {
  it("keeps the row's own cells when nothing is pending", () => {
    const cells = { [status]: "a" } as SpaceCellMap;
    expect(patchRowCells(data(cells, 3), {}, [])).toBe(cells);
  });

  it("puts pending over an acknowledged edit that the answer does not include yet", () => {
    const cells = { [status]: "a" } as SpaceCellMap;
    const acked = [{ edit: edit("b", 1), dataRevision: 4 }];
    expect(patchRowCells(data(cells, 3), {}, acked)[status]).toBe("b");
    const pending = queueCellEdit({}, edit("c", 2));
    expect(patchRowCells(data(cells, 3), pending, acked)[status]).toBe("c");
  });

  it("drops an acknowledged edit once the answer reached its revision", () => {
    const cells = { [status]: "a" } as SpaceCellMap;
    const acked = [{ edit: edit("b", 1), dataRevision: 4 }];
    expect(patchRowCells(data(cells, 4), {}, acked)).toBe(cells);
  });

  it("ignores pending edits of other rows and clears a cell for null", () => {
    const cells = { [status]: "a" } as SpaceCellMap;
    expect(patchRowCells(data(cells, 1), queueCellEdit({}, edit("z", 1, other)), [])[status]).toBe(
      "a",
    );
    expect(patchRowCells(data(cells, 1), queueCellEdit({}, edit(null, 1)), [])[status]).toBe(
      undefined,
    );
  });
});

describe("recordAck", () => {
  it("keeps only the edits of the page and returns the same array when there are none", () => {
    const empty: ReadonlyArray<never> = [];
    expect(recordAck(empty, { dataRevision: 5, edits: [edit("x", 1, other)] }, page)).toBe(empty);
    const next = recordAck(
      empty,
      { dataRevision: 5, edits: [edit("x", 1), edit("y", 2, other)] },
      page,
    );
    expect(next).toEqual([{ edit: edit("x", 1), dataRevision: 5 }]);
  });
});
