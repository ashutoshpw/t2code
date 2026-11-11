import { assert, describe, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";

import type { ComputedRecord } from "../databases/computed/Record.ts";
import type { Property, Snapshot } from "../databases/SchemaStore.ts";
import type { DataSourceRecord, ViewRecord } from "../databases/Types.ts";
import { eligible, exposed, layoutProperties, parseView, reads } from "./Exposure.ts";

const source: DataSourceRecord = {
  data_source_id: C.SpaceDataSourceId.make("here"),
  database_id: C.SpaceDatabaseId.make("db"),
  name: "Here",
  position: 0,
  schema_revision: 1,
  data_revision: 1,
  next_row_seq: 1,
  row_count: 0,
  sub_items_property_id: null,
  default_template_id: null,
  created_at: "",
  updated_at: "",
};

const computed = (
  kind: "formula" | "rollup",
  extra: Partial<ComputedRecord> & { own?: string[]; related?: string[] } = {},
): ComputedRecord => ({
  v: 1,
  kind,
  type: "text",
  deps: {
    own: extra.own ?? [],
    related: (extra.related ?? []).map((dataSourceId) => ({
      relationPropertyId: "rel",
      dataSourceId,
      propertyIds: ["title"],
    })),
  },
  volatile: extra.volatile ?? false,
  ...(extra.error === undefined ? {} : { error: extra.error }),
});

const prop = (
  id: string,
  type: C.SpacePropertyType,
  extra: Partial<Property> & { target?: string } = {},
): Property => ({
  id,
  name: id,
  type,
  config: extra.target === undefined ? {} : { dataSourceId: extra.target },
  description: null,
  position: 0,
  deletedAtMs: null,
  options: [],
  computed: null,
  ...extra,
});

const snapshotOf = (...properties: Property[]): Snapshot => ({
  source,
  all: properties,
  byId: new Map(properties.map((property) => [property.id, property])),
  live: properties.filter((property) => property.deletedAtMs === null),
});

const view = (type: string, extra: Partial<ViewRecord> = {}): ViewRecord => ({
  view_id: C.SpaceViewId.make("v1"),
  database_id: C.SpaceDatabaseId.make("db"),
  data_source_id: source.data_source_id,
  owner_block_id: null,
  name: "View",
  type,
  position: 0,
  filter: null,
  sorts: "[]",
  grouping: null,
  sub_grouping: null,
  properties: "[]",
  layout: "{}",
  logical_bytes: 0,
  orphaned_at_ms: null,
  created_at: "",
  updated_at: "",
  ...extra,
});
const inside = (...sources: string[]) => {
  const set = new Set(["here", ...sources]);
  return (id: string) => set.has(id);
};

describe("eligible", () => {
  const snapshot = snapshotOf(
    prop("title", "title"),
    prop("text", "text"),
    prop("gone", "text", { deletedAtMs: 1 }),
    prop("near", "relation", { target: "near" }),
    prop("far", "relation", { target: "far" }),
    prop("roll", "rollup", { computed: computed("rollup", { related: ["far"], own: ["far"] }) }),
    prop("okRoll", "rollup", {
      computed: computed("rollup", { related: ["near"], own: ["near"] }),
    }),
    prop("clock", "formula", { computed: computed("formula", { volatile: true }) }),
    prop("broken", "formula", { computed: computed("formula", { error: "bad" }) }),
    prop("uncompiled", "formula"),
    prop("plain", "formula", { computed: computed("formula", { own: ["text"] }) }),
    prop("viaBroken", "formula", { computed: computed("formula", { own: ["broken"] }) }),
    prop("viaClock", "formula", { computed: computed("formula", { own: ["clock"] }) }),
    prop("viaRoll", "formula", { computed: computed("formula", { own: ["roll"] }) }),
    prop("viaGone", "formula", { computed: computed("formula", { own: ["gone"] }) }),
  );
  const tree = inside("near");
  const check = (id: string) => eligible(snapshot, snapshot.byId.get(id)!, tree);

  it("accepts stored types and computed values that read only shared sources", () => {
    for (const id of ["title", "text", "near", "okRoll", "plain"]) assert.isTrue(check(id), id);
  });
  it("refuses deleted properties, outside relations and untrusted computed values", () => {
    for (const id of [
      "gone",
      "far",
      "roll",
      "clock",
      "broken",
      "uncompiled",
      "viaBroken",
      "viaClock",
      "viaRoll",
      "viaGone",
    ])
      assert.isFalse(check(id), id);
  });
});

describe("reads", () => {
  it("follows own formula chains and relations and survives cycles", () => {
    const snapshot = snapshotOf(
      prop("rel", "relation", { target: "far" }),
      prop("a", "formula", { computed: computed("formula", { own: ["b", "rel"] }) }),
      prop("b", "formula", { computed: computed("formula", { own: ["a"], related: ["deep"] }) }),
    );
    assert.deepEqual([...reads(snapshot, snapshot.byId.get("a")!)].sort(), ["deep", "far"]);
  });
});

describe("exposed", () => {
  const props = [
    prop("title", "title"),
    prop("a", "text"),
    prop("b", "text"),
    prop("when", "date"),
    prop("stamp", "created_time"),
    prop("label", "text"),
    prop("pick", "select"),
    prop("far", "relation", { target: "far" }),
    prop("calc", "formula", {
      computed: { ...computed("formula"), type: "date" },
    }),
  ];
  const snapshot = snapshotOf(...props);
  const tree = inside();
  const shown = (record: ViewRecord) => exposed(snapshot, parseView(record), tree);

  it("lists the title, then the visible eligible columns in view order", () => {
    const record = view("table", {
      properties: JSON.stringify([
        { propertyId: "b", visible: true, width: 120 },
        { propertyId: "a", visible: false },
        { propertyId: "far", visible: true },
        { propertyId: "label", visible: true, wrap: true },
      ]),
    });
    assert.deepEqual(shown(record), {
      columns: [
        { propertyId: "title" },
        { propertyId: "b", width: 120 },
        { propertyId: "label", wrap: true },
      ],
      extras: [],
    });
  });

  it("adds the group property of a grouped view as an extra when it is not a column", () => {
    const record = view("board", {
      grouping: JSON.stringify({ property: "pick" }),
      layout: JSON.stringify({ cardPreview: { kind: "property", propertyId: "a" } }),
    });
    assert.deepEqual(shown(record)?.extras, ["pick", "a"]);
    assert.isNull(shown(view("board", { grouping: JSON.stringify({ property: "far" }) })));
  });

  it("drops an unusable optional layout property but keeps the view", () => {
    const record = view("timeline", {
      layout: JSON.stringify({ startPropertyId: "when", endPropertyId: "label" }),
    });
    assert.deepEqual(shown(record)?.extras, ["when"]);
    assert.deepEqual(
      shown(
        view("timeline", {
          layout: JSON.stringify({ startPropertyId: "when", endPropertyId: "stamp" }),
        }),
      )?.extras,
      ["when", "stamp"],
    );
  });

  it("refuses unknown types and calendars without a usable date", () => {
    assert.isNull(shown(view("kanban")));
    assert.isNull(shown(view("calendar")));
    assert.isNull(shown(view("calendar", { layout: JSON.stringify({ datePropertyId: "label" }) })));
    assert.isNull(shown(view("calendar", { layout: JSON.stringify({ datePropertyId: "gone" }) })));
    for (const date of ["when", "stamp", "calc"])
      assert.isNotNull(
        shown(view("calendar", { layout: JSON.stringify({ datePropertyId: date }) })),
        date,
      );
    assert.deepEqual(layoutProperties(parseView(view("table"))).required, []);
  });
});
