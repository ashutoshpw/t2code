import { describe, expect, it } from "vite-plus/test";
import type { SpaceDatabaseRow } from "@t2code/contracts/spaces";

import type { GridItem } from "../table/gridItems";
import { buildListLayout, moveTarget } from "./listLayout";

const row = (id: string): GridItem => ({
  kind: "row",
  row: { page: { id } } as unknown as SpaceDatabaseRow,
  group: null,
});
const group: GridItem = {
  kind: "group",
  id: "g",
  bucket: { key: { kind: "empty" }, count: 0, rows: [] } as never,
  collapsed: false,
};

describe("buildListLayout", () => {
  it("stacks 32px rows under 36px group headers", () => {
    const layout = buildListLayout([group, row("a"), row("b"), { kind: "add", group: null }]);
    expect(layout.offsets).toEqual([0, 36, 68, 100]);
    expect(layout.total).toBe(132);
  });
});

describe("moveTarget", () => {
  const items = [group, row("a"), row("b"), row("c"), group, row("d")];
  it("moves up before the previous row and down by moving the next row before this one", () => {
    expect(moveTarget(items, "b", "up")).toEqual({ moving: "b", before: "a" });
    expect(moveTarget(items, "b", "down")).toEqual({ moving: "c", before: "b" });
  });
  it("stops at the edges of a group", () => {
    expect(moveTarget(items, "a", "up")).toBeNull();
    expect(moveTarget(items, "c", "down")).toBeNull();
    expect(moveTarget(items, "missing", "up")).toBeNull();
  });
});
