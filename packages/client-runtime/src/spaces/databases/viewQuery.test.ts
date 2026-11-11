import type { SpaceDatabaseView } from "@t2code/contracts/spaces";
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
});
