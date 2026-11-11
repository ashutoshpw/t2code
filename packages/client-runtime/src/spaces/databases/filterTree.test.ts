import {
  SPACE_FILTER_OPERATORS,
  type SpaceDatabaseProperty,
  type SpaceKnownFilter,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import {
  conditionAt,
  conditionForOperator,
  conditionForProperty,
  defaultCondition,
  filterShape,
  insertAt,
  prune,
  removeAt,
  rootGroup,
  setAt,
  setConnective,
  withoutProperty,
  wrapInGroup,
  type FilterCondition,
} from "./filterTree.ts";
import { knownProperty } from "./schema.ts";

const property = (id: string, type: string, config: unknown = {}) =>
  knownProperty({ id, name: id, type, config, position: 0 } as unknown as SpaceDatabaseProperty)!;
const cond = (id: string, operator = "is_empty"): FilterCondition =>
  ({ property: id, operator }) as FilterCondition;
const plain = [{ id: "a", name: "A", color: "gray" }];

describe("filter tree editing", () => {
  it("wraps a bare condition or nothing in an and group", () => {
    expect(rootGroup(undefined)).toEqual({ and: [] });
    expect(rootGroup(cond("x"))).toEqual({ and: [cond("x")] });
    expect(rootGroup({ or: [cond("x")] })).toEqual({ or: [cond("x")] });
  });

  it("inserts, replaces and removes at nested paths", () => {
    let root = rootGroup(undefined);
    root = insertAt(root, [], cond("a"));
    root = insertAt(root, [], { or: [] });
    root = insertAt(root, [1], cond("b"));
    root = insertAt(root, [1], cond("c"), 0);
    expect(root).toEqual({ and: [cond("a"), { or: [cond("c"), cond("b")] }] });
    expect(conditionAt(root, [1, 0])?.property).toBe("c");
    expect(conditionAt(root, [1])).toBeUndefined();
    root = setAt(root, [1, 1], cond("z"));
    expect(conditionAt(root, [1, 1])?.property).toBe("z");
    root = removeAt(root, [1, 0]);
    expect(root).toEqual({ and: [cond("a"), { or: [cond("z")] }] });
  });

  it("wraps a rule in a group and switches connectives per group", () => {
    let root = rootGroup({ and: [cond("a"), cond("b")] });
    root = wrapInGroup(root, [1]);
    expect(root).toEqual({ and: [cond("a"), { and: [cond("b")] }] });
    root = setConnective(root, [1], "or");
    root = setConnective(root, [], "or");
    expect(root).toEqual({ or: [cond("a"), { or: [cond("b")] }] });
    expect(wrapInGroup(root, [])).toBe(root);
  });

  it("prunes empty groups and returns null for an empty root", () => {
    expect(prune({ and: [] })).toBeNull();
    expect(prune({ and: [{ or: [] }, { and: [{ or: [] }] }] })).toBeNull();
    expect(prune({ and: [{ or: [] }, cond("a")] })).toEqual({ and: [cond("a")] });
  });

  it("drops conditions on a property and collapses what is left empty", () => {
    const filter: SpaceKnownFilter = { and: [cond("a"), { or: [cond("a"), cond("b")] }] };
    expect(withoutProperty(filter, "a" as never)).toEqual({ and: [{ or: [cond("b")] }] });
    expect(withoutProperty({ and: [cond("a")] }, "a" as never)).toBeNull();
  });

  it("measures depth and leaves with the contract's measure", () => {
    expect(filterShape(null)).toEqual({ depth: 0, conditions: 0 });
    expect(filterShape({ and: [cond("a"), { or: [cond("b")] }] })).toEqual({
      depth: 2,
      conditions: 2,
    });
  });
});

describe("default conditions", () => {
  it.each([
    ["title", {}, "equals", ""],
    ["number", { format: "number" }, "equals", 0],
    ["checkbox", {}, "equals", true],
    ["select", { options: plain }, "equals", "a"],
    ["multi_select", { options: plain }, "contains", "a"],
    ["date", {}, "equals", { relative: "today" }],
    ["created_time", {}, "equals", { relative: "today" }],
  ])("%s starts at its first operator with a value", (type, config, operator, value) => {
    expect(defaultCondition(property("p", type, config))).toEqual({
      property: "p",
      operator,
      value,
    });
  });

  it("falls back to an operator without a value when none can be given one", () => {
    expect(defaultCondition(property("p", "select", { options: [] }))).toEqual({
      property: "p",
      operator: "is_empty",
    });
    expect(
      defaultCondition(property("p", "relation", { dataSourceId: "s", limit: "many" })),
    ).toEqual({ property: "p", operator: "is_empty" });
  });

  it("every operator a known type offers is legal for its default", () => {
    for (const [type, operators] of Object.entries(SPACE_FILTER_OPERATORS)) {
      if (operators.length === 0) continue;
      const config =
        type === "number"
          ? { format: "number" }
          : type === "select" || type === "multi_select"
            ? { options: plain }
            : type === "status"
              ? { options: [{ ...plain[0]!, group: "todo" }] }
              : type === "relation"
                ? { dataSourceId: "s", limit: "one" }
                : {};
      const made = defaultCondition(property("p", type, config));
      expect(operators as ReadonlyArray<string>, type).toContain(made.operator);
    }
  });
});

describe("operator and property changes", () => {
  const status = property("s", "status", {
    options: [{ id: "x", name: "X", color: "gray", group: "todo" }],
  });
  it("keeps the value across operators of the same shape and resets across shapes", () => {
    const current = { property: "s", operator: "equals", value: "x" } as FilterCondition;
    expect(conditionForOperator(current, status, "does_not_equal" as never)).toEqual({
      property: "s",
      operator: "does_not_equal",
      value: "x",
    });
    expect(conditionForOperator(current, status, "in_group" as never)).toEqual({
      property: "s",
      operator: "in_group",
      value: "todo",
    });
    expect(conditionForOperator(current, status, "is_empty" as never)).toEqual({
      property: "s",
      operator: "is_empty",
    });
  });

  it("changing the property starts over unless the operator needs no value", () => {
    const text = property("t", "text");
    const number = property("n", "number", { format: "number" });
    expect(
      conditionForProperty({ property: "t", operator: "contains", value: "a" } as never, number),
    ).toEqual({ property: "n", operator: "equals", value: 0 });
    expect(conditionForProperty(cond("n", "is_not_empty"), text)).toEqual({
      property: "t",
      operator: "is_not_empty",
    });
  });
});
