import type {
  SpaceDataSource,
  SpaceDatabaseRow,
  SpaceDatabaseView,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import {
  knownProperty,
  knownView,
  propertyOptions,
  resolveBlockViews,
  rowTitle,
  viewColumns,
} from "./schema.ts";

const property = (id: string, type: string, position: number, config: unknown = {}) =>
  ({ id, name: id, type, config, position }) as never;
const dataSource = {
  properties: {
    title: property("title", "title", 0),
    a: property("a", "text", 1),
    b: property("b", "select", 2, { options: [{ id: "o1", name: "One", color: "blue" }] }),
    c: property("c", "future_type", 3, { x: 1 }),
  },
} as unknown as SpaceDataSource;
const view = (properties: unknown[]) =>
  ({
    id: "v1",
    databaseId: "d",
    dataSourceId: "s",
    name: "T",
    type: "table",
    position: 0,
    sorts: [],
    properties,
    layout: {},
  }) as unknown as SpaceDatabaseView;

describe("viewColumns", () => {
  it("orders by the view, skips dead ids, appends missing live properties hidden", () => {
    const columns = viewColumns(
      view([
        { propertyId: "b", visible: true, width: 120 },
        { propertyId: "gone", visible: true },
        { propertyId: "title", visible: false },
      ]),
      dataSource,
    );
    expect(columns.map((column) => [column.property.id, column.visible])).toEqual([
      ["b", true],
      ["title", true],
      ["a", false],
      ["c", false],
    ]);
    expect(columns[0]?.width).toBe(120);
  });
  it("keeps unknown types as raw properties", () => {
    const column = viewColumns(view([]), dataSource).find((entry) => entry.property.id === "c");
    expect(column?.known).toBeNull();
  });
});

describe("schema helpers", () => {
  it("decodes known properties and views once", () => {
    const select = dataSource.properties.b!;
    expect(knownProperty(select)?.type).toBe("select");
    expect(knownProperty(select)).toBe(knownProperty(select));
    expect(propertyOptions(knownProperty(select))).toHaveLength(1);
    expect(propertyOptions(knownProperty(dataSource.properties.a!))).toEqual([]);
    expect(knownView(view([]))?.type).toBe("table");
    expect(knownView({ ...view([]), type: "future" })).toBeNull();
  });
  it("reads the title from the cell, never the page", () => {
    const row = {
      page: { title: "page" },
      cells: { title: "cell" },
    } as unknown as SpaceDatabaseRow;
    expect(rowTitle(row)).toBe("cell");
    expect(rowTitle({ ...row, cells: {} })).toBe("");
  });
  it("resolves block views in block order and skips missing ids", () => {
    const views = ["a", "b", "c"].map((id) => ({ ...view([]), id }) as SpaceDatabaseView);
    expect(resolveBlockViews(["c", "x", "a"] as never, views).map((entry) => entry.id)).toEqual([
      "c",
      "a",
    ]);
  });
});
