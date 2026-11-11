import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE,
  SPACE_PAGE_SHARE_DATABASE_ROUTE,
  SPACE_PAGE_SHARE_DATABASE_ROW_ROUTE,
  SpaceSharedDatabase,
  SpaceSharedDatabaseRow,
  SpaceSharedDatabaseRowPage,
  SpaceSharedDatabaseView,
  SpaceSharedDatabaseWindow,
  SpaceSharedGroupBucket,
  SpaceSharedOption,
} from "./index.ts";

const decodeRow = Schema.decodeUnknownSync(SpaceSharedDatabaseRow);
const decodeWindow = Schema.decodeUnknownSync(SpaceSharedDatabaseWindow);
const roundTrip = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: unknown) =>
  Schema.encodeSync(schema)(Schema.decodeUnknownSync(schema)(value));

const row = { id: "row1", title: "Row", icon: "📁", cells: { p1: "x" }, cover: { assetId: "a1" } };
const view = {
  id: "v1",
  dataSourceId: "ds1",
  name: "Table",
  type: "table",
  properties: [{ propertyId: "p1", width: 120, wrap: true }],
  layout: { wrapCells: true },
  group: {
    property: "p1",
    by: "option",
    sort: "manual",
    order: [{ kind: "empty" }],
    hideEmpty: true,
  },
};
const property = { id: "p1", name: "Status", type: "select", config: { options: [] }, position: 1 };
const option = { id: "o1", name: "Todo", color: "gray", group: "todo" };
const bucket = { key: { kind: "empty" }, count: 1, rows: [row], nextCursor: null };
const related = { r1: { title: "Related", dataSourceId: "ds1" } };

describe("shared database contracts", () => {
  it("keeps the routes under the shared page prefix", () => {
    expect(SPACE_PAGE_SHARE_DATABASE_ROUTE).toBe("/api/shared-page/database");
    expect(SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE).toBe("/api/shared-page/database/query");
    expect(SPACE_PAGE_SHARE_DATABASE_ROW_ROUTE).toBe("/api/shared-page/database/row");
  });

  it("round-trips every shape and accepts the minimal forms", () => {
    expect(roundTrip(SpaceSharedDatabaseView, view)).toEqual(view);
    const { group: _group, ...ungrouped } = view;
    expect(roundTrip(SpaceSharedDatabaseView, { ...ungrouped, properties: [] })).toEqual({
      ...ungrouped,
      properties: [],
    });
    expect(roundTrip(SpaceSharedOption, option)).toEqual(option);
    expect(roundTrip(SpaceSharedDatabaseRow, row)).toEqual(row);
    expect(roundTrip(SpaceSharedDatabaseRow, { id: "row1", title: "", cells: {} })).toEqual({
      id: "row1",
      title: "",
      cells: {},
    });
    expect(roundTrip(SpaceSharedGroupBucket, bucket)).toEqual(bucket);
    const database = {
      database: { id: "db1", title: "Tasks" },
      dataSources: [{ id: "ds1", name: "Tasks", properties: { p1: property } }],
      views: [view],
    };
    expect(roundTrip(SpaceSharedDatabase, database)).toEqual(database);
    const window = {
      rows: [row],
      groups: [bucket],
      groupsTruncated: true,
      relatedPages: related,
      options: { p1: [option] },
      nextCursor: "sealed",
    };
    expect(roundTrip(SpaceSharedDatabaseWindow, window)).toEqual(window);
    const page = {
      row,
      relatedPages: related,
      options: {},
      window: { revision: 1, blocks: [] },
      nextCursor: "next",
      breadcrumb: [{ id: "host", title: "Host" }],
    };
    expect(roundTrip(SpaceSharedDatabaseRowPage, page)).toEqual(page);
  });

  it("does not carry fields of the signed-in wire through a decode", () => {
    const decoded = decodeRow({
      ...row,
      revision: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(Object.keys(decoded).toSorted()).toEqual(["cells", "cover", "icon", "id", "title"]);
    expect(() =>
      decodeWindow({
        rows: [],
        relatedPages: {},
        options: {},
      }),
    ).toThrow();
  });
});
