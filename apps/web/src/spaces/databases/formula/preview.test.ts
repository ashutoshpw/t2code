import type { SpaceDataSource, SpaceDatabaseProperty } from "@t2code/contracts/spaces";
import { compile } from "@t2code/shared/formula";
import { formulaSchemaOf } from "@t2code/client-runtime/spaces";
import { describe, expect, it } from "vite-plus/test";

import { previewText } from "./preview";

const property = (id: string, name: string, type: string, config: unknown = {}) =>
  ({ id, name, type, config, position: 0 }) as unknown as SpaceDatabaseProperty;
const properties = [
  property("title", "Name", "title"),
  property("est", "Estimate", "number"),
  property("st", "Stage", "select", { options: [{ id: "o1", name: "Doing", color: "blue" }] }),
  property("due", "Due", "date"),
];
const dataSource = {
  id: "tasks",
  properties: Object.fromEntries(properties.map((entry) => [entry.id, entry])),
} as unknown as SpaceDataSource;
const row = {
  id: "r1",
  title: "Ship it",
  cells: { est: 4, st: "o1", due: { start: "2026-03-10" } },
};
const options = { relatedPages: {}, now: Date.UTC(2026, 2, 1), timeZone: "UTC" };

const preview = (source: string) => {
  const { compiled, diagnostics } = compile(
    source,
    formulaSchemaOf(dataSource, () => undefined),
  );
  expect(diagnostics).toEqual([]);
  return previewText(compiled!, dataSource, row, options);
};

describe("formula preview", () => {
  it("evaluates over the sample row's stored cells", () => {
    expect(preview('prop("Estimate") * 2')).toBe("8");
    expect(preview('prop("Stage") + " / " + prop("Name")')).toBe("Doing / Ship it");
    expect(preview('dateBetween(prop("Due"), today(), "days")')).toBe("9");
  });

  it("has no preview when the formula reads properties of related pages", () => {
    const related = {
      id: "projects",
      properties: {
        title: property("title", "Name", "title"),
        tasks: property("tasks", "Tasks", "relation", { dataSourceId: "tasks", limit: "many" }),
      },
    } as unknown as SpaceDataSource;
    const { compiled } = compile(
      'prop("Tasks").map(current.prop("Estimate")).sum()',
      formulaSchemaOf(related, (id) => (id === "tasks" ? dataSource : undefined)),
    );
    expect(previewText(compiled!, related, { id: "p", title: "P", cells: {} }, options)).toBeNull();
  });
});
