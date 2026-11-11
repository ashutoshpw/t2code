import type { SpaceDataSource, SpaceDatabaseProperty } from "@t2code/contracts/spaces";
import { compile } from "@t2code/shared/formula";
import { describe, expect, it } from "vite-plus/test";

import {
  computedInputs,
  formulaSchemaOf,
  formulaTypeOfProperty,
  knownComputedValue,
  propertyQueryType,
  knownQueryType,
  relationTargetIds,
  unqueryableReason,
} from "./computed.ts";
import { knownProperty } from "./schema.ts";

const property = (
  id: string,
  name: string,
  type: string,
  extra: Partial<SpaceDatabaseProperty> = {},
): SpaceDatabaseProperty =>
  ({ id, name, type, config: {}, position: 0, ...extra }) as unknown as SpaceDatabaseProperty;

const dataSource = (id: string, properties: SpaceDatabaseProperty[]): SpaceDataSource =>
  ({
    id,
    properties: Object.fromEntries(properties.map((entry) => [entry.id, entry])),
  }) as unknown as SpaceDataSource;

const tasks = dataSource("tasks", [
  property("title", "Name", "title"),
  property("est", "Estimate", "number", { config: { format: "number" } }),
  property("tags", "Tags", "multi_select"),
  property("f1", "Double", "formula", {
    config: { expression: 'prop("Estimate") * 2' },
    computed: { resultType: "number", queryType: "number", inputs: ["est"] as never },
  }),
  property("f2", "Quad", "formula", {
    config: { expression: "1" },
    computed: { resultType: "number", queryType: "number", inputs: ["f1"] as never },
  }),
  property("f3", "Now", "formula", {
    config: { expression: "now()" },
    computed: { resultType: "date", volatile: true, inputs: [] },
  }),
  property("f4", "Broken", "formula", {
    config: { expression: "1" },
    computed: { resultType: "text", inputs: [], error: { message: "bad" } },
  }),
]);
const projects = dataSource("projects", [
  property("title", "Title", "title"),
  property("tasks", "Tasks", "relation", { config: { dataSourceId: "tasks", limit: "many" } }),
]);

describe("computed properties", () => {
  it("maps properties to query and formula types", () => {
    expect(propertyQueryType(tasks.properties["f1"]!)).toBe("number");
    expect(propertyQueryType(tasks.properties["f3"]!)).toBeUndefined();
    expect(propertyQueryType(tasks.properties["est"]!)).toBe("number");
    expect(formulaTypeOfProperty(tasks.properties["tags"]!)).toEqual({ list: "text" });
    expect(formulaTypeOfProperty(tasks.properties["f4"]!)).toBe("any");
    expect(formulaTypeOfProperty(projects.properties["tasks"]!)).toEqual({
      list: { page: "tasks" },
    });
  });

  it("keeps a computed property decodable as a known property", () => {
    const formula = property("f9", "F", "formula", {
      config: { expression: "1" },
      computed: { resultType: "number", queryType: "number" },
    });
    expect(knownProperty(formula)?.type).toBe("formula");
  });

  it("follows inputs through other computed properties", () => {
    expect([...computedInputs(tasks, "f2" as never)].sort()).toEqual(["est", "f1"]);
    expect([...computedInputs(tasks, "est" as never)]).toEqual([]);
  });

  it("builds a schema the engine checks against, one relation away", () => {
    const schema = formulaSchemaOf(projects, (id) => (id === "tasks" ? tasks : undefined));
    expect(relationTargetIds(projects)).toEqual(["tasks"]);
    expect(
      compile('prop("Tasks").map(current.prop("Estimate")).sum()', schema).diagnostics,
    ).toEqual([]);
    const bad = compile('prop("Nope")', schema).diagnostics[0];
    expect(bad).toMatchObject({ code: "unknown_property" });
    const unloaded = formulaSchemaOf(projects, () => undefined);
    expect(unloaded.source("tasks")).toBeUndefined();
  });

  it("decodes only the computed value shapes it renders", () => {
    expect(knownComputedValue({ type: "number", value: 3 })).toEqual({ type: "number", value: 3 });
    expect(knownComputedValue({ type: "future", value: 3 })).toBeUndefined();
  });

  it("explains why a computed property cannot be filtered, and when it can", () => {
    expect(unqueryableReason(tasks.properties["f1"]!)).toBeUndefined();
    expect(unqueryableReason(tasks.properties["est"]!)).toBeUndefined();
    expect(unqueryableReason(tasks.properties["f3"]!)).toContain("now()");
    expect(unqueryableReason(tasks.properties["f4"]!)).toBe("bad");
    expect(unqueryableReason(property("f5", "Legacy", "formula"))).toBe("Not calculated yet");
    expect(
      unqueryableReason(
        property("f6", "List", "rollup", { computed: { resultType: { list: "text" } } }),
      ),
    ).toContain("can't be filtered");
  });

  it("reads the query type of a known property", () => {
    expect(knownQueryType(knownProperty(tasks.properties["f1"]!)!)).toBe("number");
    expect(knownQueryType(knownProperty(tasks.properties["f3"]!)!)).toBeUndefined();
    expect(knownQueryType(knownProperty(tasks.properties["est"]!)!)).toBe("number");
  });
});
