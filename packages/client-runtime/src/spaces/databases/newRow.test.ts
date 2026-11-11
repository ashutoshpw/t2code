import type {
  SpaceFilter,
  SpaceDatabaseProperty,
  SpaceKnownGroupKey,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { cellForGroupKey, newRowCells, templateForNewRow } from "./newRow.ts";
import { knownProperty } from "./schema.ts";

const property = (id: string, type: string, config: unknown = {}) =>
  ({ id, name: id, type, config, position: 0 }) as unknown as SpaceDatabaseProperty;
const options = [
  { id: "todo1", name: "A", color: "gray", group: "todo" },
  { id: "done1", name: "B", color: "green", group: "complete" },
  { id: "done2", name: "C", color: "green", group: "complete" },
];
const plain = options.map(({ group: _group, ...option }) => option);
const properties = {
  title: property("title", "title"),
  text: property("text", "text"),
  num: property("num", "number", { format: "number" }),
  sel: property("sel", "select", { options: plain }),
  multi: property("multi", "multi_select", { options: plain }),
  status: property("status", "status", { options, defaultOptionId: "done2" }),
  check: property("check", "checkbox"),
  date: property("date", "date"),
  rel: property("rel", "relation", { dataSourceId: "s", limit: "many" }),
  made: property("made", "created_time"),
};
const known = (id: keyof typeof properties) => knownProperty(properties[id])!;
const key = (value: unknown) => value as SpaceKnownGroupKey;

describe("cellForGroupKey", () => {
  it.each([
    ["sel", { kind: "option", optionId: "o" }, "o"],
    ["multi", { kind: "option", optionId: "o" }, ["o"]],
    ["status", { kind: "status_group", group: "complete" }, "done2"],
    ["status", { kind: "status_group", group: "todo" }, "todo1"],
    ["check", { kind: "checkbox", value: true }, true],
    ["check", { kind: "checkbox", value: false }, null],
    ["text", { kind: "text", value: "x" }, [{ text: "x", marks: [] }]],
    ["date", { kind: "date", start: "2026-01-02", unit: "day" }, { start: "2026-01-02" }],
    ["date", { kind: "date", start: "2026-01-01", unit: "month" }, undefined],
    ["num", { kind: "number_range", start: 0, end: 10 }, undefined],
    ["rel", { kind: "page", pageId: "p" }, ["p"]],
    ["sel", { kind: "empty" }, null],
  ] as const)("%s %j", (id, groupKey, expected) => {
    expect(cellForGroupKey(key(groupKey), known(id))).toEqual(expected);
  });
});

describe("newRowCells", () => {
  const filter = {
    and: [
      { property: "title", operator: "contains", value: "hi" },
      { property: "num", operator: "equals", value: 4 },
      { property: "num", operator: "greater_than", value: 9 },
      { property: "status", operator: "in_group", value: "complete" },
      { property: "date", operator: "equals", value: { relative: "tomorrow" } },
      { property: "made", operator: "equals", value: "2026-01-01" },
      { or: [{ property: "text", operator: "equals", value: "never" }] },
      { and: [{ property: "check", operator: "equals", value: true }] },
    ],
  };
  it("takes values from and-conditions only and never fills read-only types", () => {
    expect(newRowCells({ filter: filter as SpaceFilter, properties, today: "2026-01-31" })).toEqual(
      {
        title: "hi",
        num: 4,
        status: "done2",
        date: { start: "2026-02-01" },
        check: true,
      },
    );
    expect(
      newRowCells({ filter: { or: filter.and } as SpaceFilter, properties, today: "2026-01-31" }),
    ).toEqual({});
  });
  it("lets the group value win over the filter value", () => {
    const cells = newRowCells({
      filter: filter as SpaceFilter,
      properties,
      today: "2026-01-31",
      group: { property: "status" as never, key: key({ kind: "status_group", group: "todo" }) },
    });
    expect(cells.status).toBe("todo1");
  });
});

describe("templateForNewRow", () => {
  const source = {
    defaultTemplateId: "t1",
    templates: [
      { pageId: "t1", title: "Bug" },
      { pageId: "t2", title: "Idea" },
    ],
  } as unknown as Parameters<typeof templateForNewRow>[0];
  it("uses the default unless the caller chose, and ignores a template that is gone", () => {
    expect(templateForNewRow(source, undefined)).toBe("t1");
    expect(templateForNewRow(source, null)).toBeUndefined();
    expect(templateForNewRow(source, "t2" as never)).toBe("t2");
    expect(templateForNewRow(source, "gone" as never)).toBeUndefined();
    expect(
      templateForNewRow({ ...source, defaultTemplateId: "gone" as never }, undefined),
    ).toBeUndefined();
  });
});
