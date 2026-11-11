import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";

import type { Json } from "../databases/Json.ts";
import type { Property, Snapshot } from "../databases/SchemaStore.ts";
import type { DataSourceRecord } from "../databases/Types.ts";
import { type OptionLedger, sanitizeRow } from "./Sanitize.ts";

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

const files: Property = {
  id: "files01",
  name: "Files",
  type: "files",
  config: {},
  description: null,
  position: 0,
  deletedAtMs: null,
  options: [],
  computed: null,
};

const snapshot: Snapshot = {
  source,
  all: [files],
  byId: new Map([[files.id, files]]),
  live: [files],
};

const ledger: OptionLedger = {
  noteCell: () => undefined,
  noteKey: () => undefined,
  build: () => ({}),
};

const rowWith = (value: Json): C.SpaceDatabaseRow => ({
  page: {
    id: C.SpacePageId.make("row01"),
    title: "Row",
    revision: 0,
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z",
  },
  number: 1,
  cells: { [files.id]: value },
});

const filesOf = (value: Json) =>
  sanitizeRow(
    { exposed: { columns: [{ propertyId: files.id }], extras: [] }, snapshot },
    rowWith(value),
    new Set(),
    ledger,
  ).cells[files.id];

it("keeps only http(s) files with a name and drops every other key", () => {
  assert.deepEqual(
    filesOf([
      { name: "ok", url: "https://ok.example/a.png", secret: "SECRET" },
      { name: "plain", url: "http://ok.example/b.png" },
      { name: "script", url: "javascript:alert(1)" },
      { name: "inline", url: "data:text/html,<b>x</b>" },
      { name: "local", url: "file:///etc/passwd" },
      { url: "https://nameless.example/c.png" },
      { name: "no url" },
      "https://bare.example",
    ]),
    [
      { name: "ok", url: "https://ok.example/a.png" },
      { name: "plain", url: "http://ok.example/b.png" },
    ],
  );
});

it("answers an empty list for a files cell that is not a list", () => {
  assert.isUndefined(filesOf({ name: "ok", url: "https://ok.example" }));
  assert.deepEqual(filesOf([]), []);
});
