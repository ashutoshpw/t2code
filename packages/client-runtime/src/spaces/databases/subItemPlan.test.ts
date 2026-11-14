import type { SpaceDatabaseProperty } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { planSubItems } from "./subItemPlan.ts";

const relation = (id: string, name: string, config: object, position = 0) =>
  ({ id, name, type: "relation", config, position }) as unknown as SpaceDatabaseProperty;
const byId = (...properties: SpaceDatabaseProperty[]) =>
  Object.fromEntries(properties.map((property) => [property.id, property]));
const self = (limit: "one" | "many", twin: string) => ({
  dataSourceId: "ds",
  limit,
  twoWay: { propertyId: twin },
});

describe("planSubItems", () => {
  it("creates the default pair when nothing is there", () => {
    expect(planSubItems("ds" as never, {})).toEqual({
      kind: "create",
      parentName: "Parent item",
      childName: "Sub-items",
    });
  });

  it("reuses the existing pair, preferring the one named Parent item", () => {
    const properties = byId(
      relation("up11", "Boss", self("one", "dn11"), 0),
      relation("dn11", "Reports", self("many", "up11"), 1),
      relation("up22", "Parent item", self("one", "dn22"), 2),
      relation("dn22", "Sub-items", self("many", "up22"), 3),
    );
    expect(planSubItems("ds" as never, properties)).toEqual({
      kind: "reuse",
      parentPropertyId: "up22",
    });
    const { up22: _a, dn22: _b, ...rest } = properties;
    expect(planSubItems("ds" as never, rest)).toEqual({
      kind: "reuse",
      parentPropertyId: "up11",
    });
  });

  it("picks free names when the defaults are taken by other properties", () => {
    const properties = byId(
      relation("a111", "Parent item", { dataSourceId: "other", limit: "many" }, 0),
      relation("b111", "Sub-items", { dataSourceId: "ds", limit: "many" }, 1),
    );
    expect(planSubItems("ds" as never, properties)).toEqual({
      kind: "create",
      parentName: "Parent item 2",
      childName: "Sub-items 2",
    });
  });
});
