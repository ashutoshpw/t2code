import type {
  SpaceDataSource,
  SpaceDatabaseView,
  SpaceFilter,
  SpacePropertyId,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { queryKey } from "./queryKey.ts";
import { viewDependencies, viewQueryInput } from "./viewQuery.ts";

const view = {
  id: "v1",
  databaseId: "d",
  dataSourceId: "s",
  name: "T",
  type: "table",
  position: 0,
  filter: {
    and: [
      { property: "a", operator: "equals", value: 1 },
      { or: [{ property: "f", operator: "is_empty" }] },
    ],
  },
  sorts: [{ property: "s", direction: "ascending" }],
  group: { property: "g" },
  properties: [
    { propertyId: "a", visible: true, aggregate: "count" },
    { propertyId: "b", visible: true },
  ],
  layout: {},
} as unknown as SpaceDatabaseView;
const options = {
  environmentId: "e" as never,
  mode: "rows" as const,
  timeZone: "UTC",
  limit: 100,
  visiblePropertyIds: ["b", "a"] as never,
  includeAggregates: true,
};

describe("viewQueryInput", () => {
  it("sends the definition explicitly and never a viewId", () => {
    const input = viewQueryInput(view, options);
    expect("viewId" in input).toBe(false);
    expect(input.group).toBeNull();
    expect(input.aggregates).toEqual([{ property: "a", function: "count" }]);
    expect("search" in input).toBe(false);
    expect(viewQueryInput(view, { ...options, mode: "groups", rowsPerGroup: 25 }).group).toEqual({
      property: "g",
    });
  });
  it("keeps presentation fields of a group out of the query key", () => {
    const groups = { ...options, mode: "groups" as const };
    const base = queryKey(viewQueryInput({ ...view, group: { property: "g" as never } }, groups));
    const toggled = {
      ...view,
      group: {
        property: "g",
        hidden: [{ kind: "empty" }],
        collapsed: [],
        order: [],
        hideEmpty: true,
      },
    } as unknown as typeof view;
    expect(queryKey(viewQueryInput(toggled, groups))).toBe(base);
  });
  it("asks for covers only on request, and that changes the key", () => {
    const plain = viewQueryInput(view, options);
    const covered = viewQueryInput(view, { ...options, cover: true });
    expect("include" in plain).toBe(false);
    expect(covered.include).toEqual({ cover: true });
    expect(queryKey(covered)).not.toBe(queryKey(plain));
  });
  it("keeps the key stable under column order and changes it with the filter", () => {
    const key = queryKey(viewQueryInput(view, options));
    expect(
      queryKey(viewQueryInput(view, { ...options, visiblePropertyIds: ["a", "b"] as never })),
    ).toBe(key);
    expect(queryKey(viewQueryInput({ ...view, filter: { and: [] } }, options))).not.toBe(key);
    expect(queryKey(viewQueryInput(view, { ...options, search: "x" }))).not.toBe(key);
  });
  it("collects every dependency", () => {
    expect([...viewDependencies(view)].sort()).toEqual(["a", "f", "g", "s"]);
  });
  it("adds the extra filter to the key, the dependencies and the returned cells", () => {
    const extraFilter: SpaceFilter = {
      property: "d" as SpacePropertyId,
      operator: "on_or_before",
      value: "2026-03-01",
    };
    const input = viewQueryInput(view, {
      ...options,
      extraFilter,
      extraPropertyIds: ["d"] as never,
    });
    expect(input.extraFilter).toEqual(extraFilter);
    expect(input.properties).toEqual(["a", "b", "d"]);
    expect(queryKey(input)).not.toBe(queryKey(viewQueryInput(view, options)));
    expect([...viewDependencies(view, extraFilter)].sort()).toEqual(["a", "d", "f", "g", "s"]);
  });
  it("sends the sub-item scope and de-duplicates extra cells", () => {
    const input = viewQueryInput(view, {
      ...options,
      extraPropertyIds: ["a"] as never,
      scope: { parentRowId: null },
    });
    expect(input.scope).toEqual({ parentRowId: null });
    expect(input.properties).toEqual(["a", "b"]);
  });
});

describe("viewDependencies with computed properties", () => {
  const dataSource = {
    id: "s",
    properties: {
      b: { id: "b", type: "number", computed: undefined },
      f1: { id: "f1", type: "formula", computed: { resultType: "number", inputs: ["b"] } },
      f2: { id: "f2", type: "formula", computed: { resultType: "number", inputs: ["f1", "x"] } },
    },
  } as unknown as SpaceDataSource;

  it("adds the input closure of visible and viewed computed properties, not the visible ones", () => {
    const ids = viewDependencies(view, undefined, dataSource, ["f2", "b"] as never);
    expect([...ids].sort()).toEqual(["a", "b", "f", "f1", "g", "s", "x"]);
    const sorted = viewDependencies(
      { ...view, sorts: [{ property: "f1", direction: "ascending" }] } as never,
      undefined,
      dataSource,
    );
    expect(sorted.has("b" as never)).toBe(true);
  });
});
