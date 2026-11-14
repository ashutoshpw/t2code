import {
  SpaceDataSourceId,
  SpaceDatabaseId,
  SpacePropertyId,
  SpaceViewId,
  type SpaceDataSource,
  type SpaceDatabaseProperty,
  type SpaceDatabaseView,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { knownView } from "./schema.ts";
import {
  datePropertyCandidates,
  defaultViewDraft,
  layoutForTypeChange,
  seedCellsForView,
} from "./viewDefaults.ts";

const pid = SpacePropertyId.make;
const property = (id: string, type: string, position: number): SpaceDatabaseProperty => ({
  id: pid(id),
  name: id,
  type,
  config: type === "status" ? { options: [] } : {},
  position,
});
const source = (...properties: SpaceDatabaseProperty[]): SpaceDataSource => ({
  id: SpaceDataSourceId.make("ds"),
  databaseId: SpaceDatabaseId.make("db"),
  name: "Tasks",
  position: 0,
  schemaRevision: 1,
  dataRevision: 1,
  properties: Object.fromEntries(properties.map((entry) => [entry.id, entry])),
  deletedProperties: [],
  templates: [],
});

const withDates = source(
  property("title", "title", 0),
  property("edited", "last_edited_time", 1),
  property("due", "date", 2),
  property("state", "status", 3),
);
const noDates = source(property("title", "title", 0));

describe("view defaults", () => {
  it("lists writable dates before created and edited times", () => {
    expect(datePropertyCandidates(withDates).map((entry) => entry.id)).toEqual(["due", "edited"]);
    expect(datePropertyCandidates(noDates)).toEqual([]);
  });

  it("gives each type a name and the layout it requires", () => {
    expect(defaultViewDraft("table", withDates)).toEqual({ name: "Table", layout: {} });
    expect(defaultViewDraft("board", withDates)).toEqual({
      name: "Board",
      layout: { colorColumns: true },
      group: { property: "state" },
    });
    expect(defaultViewDraft("calendar", withDates).layout).toEqual({ datePropertyId: "due" });
    expect(defaultViewDraft("timeline", withDates).layout).toEqual({ startPropertyId: "due" });
    // With no date property the caller adds one and passes its id.
    expect(defaultViewDraft("calendar", noDates).layout).toEqual({});
    expect(defaultViewDraft("calendar", noDates, pid("fresh")).layout).toEqual({
      datePropertyId: "fresh",
    });
  });

  it("keeps the keys both types know on a type change and adds the required ones", () => {
    const previous = { openPagesIn: "full_page", cardSize: "large", wrapCells: true };
    expect(layoutForTypeChange("gallery", withDates, previous)).toEqual({
      openPagesIn: "full_page",
      cardSize: "large",
    });
    expect(layoutForTypeChange("calendar", withDates, previous)).toEqual({
      openPagesIn: "full_page",
      datePropertyId: "due",
    });
    expect(
      layoutForTypeChange("timeline", withDates, { datePropertyId: "edited", mode: "week" }),
    ).toEqual({
      startPropertyId: "edited",
    });
    expect(layoutForTypeChange("calendar", noDates, previous, pid("fresh"))).toEqual({
      openPagesIn: "full_page",
      datePropertyId: "fresh",
    });
  });

  it("tints a board converted from a type that never stored the flag, never one that did", () => {
    expect(layoutForTypeChange("board", withDates, { cardSize: "large" })).toEqual({
      cardSize: "large",
      colorColumns: true,
    });
    expect(layoutForTypeChange("board", withDates, { colorColumns: false })).toEqual({
      colorColumns: false,
    });
  });

  it("seeds today into the writable date properties of calendar and timeline only", () => {
    const view = (type: string, layout: SpaceDatabaseView["layout"]) =>
      knownView({
        id: SpaceViewId.make("v"),
        databaseId: SpaceDatabaseId.make("db"),
        dataSourceId: SpaceDataSourceId.make("ds"),
        name: type,
        type,
        position: 0,
        sorts: [],
        properties: [],
        layout,
      });
    const today = "2026-11-11";
    expect(seedCellsForView(view("calendar", { datePropertyId: "due" }), withDates, today)).toEqual(
      {
        due: { start: today },
      },
    );
    expect(
      seedCellsForView(view("calendar", { datePropertyId: "edited" }), withDates, today),
    ).toEqual({});
    const two = source(property("a", "date", 0), property("b", "date", 1));
    expect(
      seedCellsForView(view("timeline", { startPropertyId: "a", endPropertyId: "b" }), two, today),
    ).toEqual({ a: { start: today }, b: { start: today } });
    expect(
      seedCellsForView(view("timeline", { startPropertyId: "a", endPropertyId: "a" }), two, today),
    ).toEqual({
      a: { start: today },
    });
    expect(seedCellsForView(view("table", {}), withDates, today)).toEqual({});
    expect(seedCellsForView(null, withDates, today)).toEqual({});
  });
});
