import { describe, expect, it } from "vite-plus/test";
import type { SpaceDatabaseRow, SpaceGroupBucket } from "@t2code/contracts/spaces";

import { buildGridItems, visibleBuckets, WRAPPED_ROW_HEIGHT } from "./gridItems";

const row = (id: string) =>
  ({ page: { id }, number: 1, cells: { title: id } }) as unknown as SpaceDatabaseRow;
const bucket = (kind: string, rows: string[], count = rows.length, extra: object = {}) =>
  ({
    key: { kind, ...extra },
    count,
    rows: rows.map(row),
    nextCursor: null,
  }) as unknown as SpaceGroupBucket;
const base = {
  rows: [],
  groups: null,
  collapsed: new Set<string>(),
  hasMore: false,
  loadingMore: false,
  canAdd: true,
};

describe("buildGridItems", () => {
  it("stacks rows, then the add item, with offsets of 34px", () => {
    const layout = buildGridItems({ ...base, rows: [row("a"), row("b")] });
    expect(layout.items.map((item) => item.kind)).toEqual(["row", "row", "add"]);
    expect(layout.offsets).toEqual([0, 34, 68]);
    expect(layout.total).toBe(102);
    expect(layout.rowIds).toEqual(["a", "b"]);
    expect(layout.itemIndexByRow.get("b")).toBe(1);
  });

  it("shows skeleton rows while loading more and no add item without permission", () => {
    const layout = buildGridItems({ ...base, rows: [row("a")], loadingMore: true, canAdd: false });
    expect(layout.items.map((item) => item.kind)).toEqual([
      "row",
      "skeleton",
      "skeleton",
      "skeleton",
    ]);
  });

  it("builds groups with 36px headers, a more item for partial buckets and no rows when collapsed", () => {
    const todo = bucket("option", ["a"], 3, { optionId: "todo" });
    const done = bucket("option", ["b"], 1, { optionId: "done" });
    const collapsed = new Set([JSON.stringify(done.key)]);
    const layout = buildGridItems({
      ...base,
      groups: [todo, done],
      collapsed: new Set([...collapsed].map((key) => key)),
      canAdd: (key) => key.kind !== "empty",
    });
    expect(layout.items.map((item) => item.kind)).toEqual(["group", "row", "more", "add", "group"]);
    expect(layout.offsets.slice(0, 3)).toEqual([0, 36, 70]);
    expect(layout.rowIds).toEqual(["a"]);
  });

  it("leaves out the add item of a group that cannot be written", () => {
    const layout = buildGridItems({
      ...base,
      groups: [bucket("empty", [])],
      canAdd: (key) => key.kind !== "empty",
    });
    expect(layout.items.map((item) => item.kind)).toEqual(["group"]);
  });
});

describe("visibleBuckets", () => {
  it("drops hidden groups and, with hideEmpty, empty ones but never the empty-value bucket", () => {
    const a = bucket("option", ["x"], 1, { optionId: "a" });
    const b = bucket("option", [], 0, { optionId: "b" });
    const c = bucket("option", ["y"], 1, { optionId: "c" });
    const none = bucket("empty", [], 0);
    const group = { hidden: [c.key], hideEmpty: true };
    expect(visibleBuckets([a, b, c, none], group)).toEqual([a, none]);
    expect(visibleBuckets([a, b], undefined)).toEqual([a, b]);
  });
});

describe("buildGridItems with sub-items and wrapped rows", () => {
  const parent = (id: string, childCount: number) =>
    ({ ...row(id), childCount }) as unknown as SpaceDatabaseRow;
  const ready = (rows: SpaceDatabaseRow[], extra: object = {}) => ({
    rows,
    status: "ready" as const,
    hasMore: false,
    loadingMore: false,
    ...extra,
  });

  it("lists children under an expanded parent with depth, load more and a new sub-item line", () => {
    const layout = buildGridItems({
      ...base,
      rows: [parent("a", 2), parent("b", 0)],
      canAdd: false,
      tree: {
        canAddChild: true,
        children: new Map([
          ["a", ready([parent("a1", 1), parent("a2", 0)], { hasMore: true })],
          ["a1", ready([parent("a1x", 0)])],
        ]),
      },
    });
    expect(
      layout.items.map((item) =>
        item.kind === "row"
          ? `${"-".repeat(item.depth ?? 0)}${item.row.page.id}${item.expandable ? "+" : ""}${item.expanded ? "!" : ""}`
          : item.kind,
      ),
    ).toEqual(["a+!", "-a1+!", "--a1x", "addChild", "-a2", "moreChildren", "addChild", "b"]);
    expect(layout.rowIds).toEqual(["a", "a1", "a1x", "a2", "b"]);
  });

  it("shows a skeleton while an expanded parent loads and ignores the tree in groups", () => {
    const loading = buildGridItems({
      ...base,
      rows: [parent("a", 1)],
      canAdd: false,
      tree: {
        canAddChild: false,
        children: new Map([["a", ready([], { status: "loading" })]]),
      },
    });
    expect(loading.items.map((item) => item.kind)).toEqual(["row", "skeleton"]);
    const grouped = buildGridItems({
      ...base,
      groups: [bucket("empty", ["g1"])],
      canAdd: false,
      tree: { canAddChild: true, children: new Map([["g1", ready([parent("x", 0)])]]) },
    });
    expect(grouped.items.map((item) => item.kind)).toEqual(["group", "row"]);
  });

  it("sizes rows by the wrapped height but keeps footer items at 34px", () => {
    const layout = buildGridItems({
      ...base,
      rows: [row("a"), row("b")],
      rowHeight: WRAPPED_ROW_HEIGHT,
    });
    expect(layout.offsets).toEqual([0, 76, 152]);
    expect(layout.total).toBe(186);
    expect(layout.rowHeight).toBe(76);
  });
});

describe("buildGridItems group aggregates", () => {
  it("adds a calculation line under an open group's rows when asked, not for collapsed or bare groups", () => {
    const withAggregates = {
      ...bucket("empty", ["a"]),
      aggregates: [{ property: "x", function: "count", number: 1 }],
    } as unknown as SpaceGroupBucket;
    const input = {
      ...base,
      groups: [withAggregates, bucket("option", ["b"], 1, { optionId: "o" })],
    };
    expect(
      buildGridItems({ ...input, groupAggregates: true, canAdd: false }).items.map((i) => i.kind),
    ).toEqual(["group", "row", "aggregate", "group", "row"]);
    expect(buildGridItems({ ...input, canAdd: false }).items.map((i) => i.kind)).toEqual([
      "group",
      "row",
      "group",
      "row",
    ]);
    expect(
      buildGridItems({
        ...input,
        groupAggregates: true,
        canAdd: false,
        collapsed: new Set([JSON.stringify({ kind: "empty" })]),
      }).items.map((i) => i.kind),
    ).toEqual(["group", "group", "row"]);
  });
});
