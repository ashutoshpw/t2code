import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

// Purely additive. Existing formula and rollup properties keep `computed` NULL and are compiled the
// first time the server touches their data source.
export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`ALTER TABLE spaces_db_properties ADD COLUMN computed TEXT`;
  yield* sql`CREATE TABLE spaces_db_computed_deps (
    data_source_id TEXT NOT NULL,
    property_id TEXT NOT NULL,
    via_property_id TEXT NOT NULL DEFAULT '',
    dep_data_source_id TEXT NOT NULL,
    dep_property_id TEXT NOT NULL,
    PRIMARY KEY (data_source_id, property_id, via_property_id, dep_data_source_id, dep_property_id),
    FOREIGN KEY (data_source_id, property_id)
      REFERENCES spaces_db_properties(data_source_id, property_id) ON DELETE CASCADE
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX spaces_db_computed_deps_dep
    ON spaces_db_computed_deps(dep_data_source_id, dep_property_id)`;
  yield* sql`CREATE TABLE spaces_db_computed_dirty (
    page_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces_pages(page_id) ON DELETE CASCADE,
    data_source_id TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX spaces_db_computed_dirty_source ON spaces_db_computed_dirty(data_source_id)`;
});
