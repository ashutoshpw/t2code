import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

// Purely additive: new tables, plus defaulted or nullable columns on spaces_pages.
export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`CREATE TABLE spaces_db_databases (
    database_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces_ids(id),
    space_id TEXT NOT NULL REFERENCES spaces(space_id),
    title TEXT NOT NULL,
    icon TEXT,
    home_block_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    orphaned_at_ms INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX spaces_db_databases_home
    ON spaces_db_databases(home_block_id) WHERE home_block_id IS NOT NULL`;
  yield* sql`CREATE INDEX spaces_db_databases_space
    ON spaces_db_databases(space_id, created_at, database_id)`;
  yield* sql`CREATE TABLE spaces_db_data_sources (
    data_source_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces_ids(id),
    database_id TEXT NOT NULL REFERENCES spaces_db_databases(database_id),
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    schema_revision INTEGER NOT NULL DEFAULT 0,
    data_revision INTEGER NOT NULL DEFAULT 0,
    next_row_seq INTEGER NOT NULL DEFAULT 1,
    row_count INTEGER NOT NULL DEFAULT 0,
    sub_items_property_id TEXT,
    default_template_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX spaces_db_data_sources_database
    ON spaces_db_data_sources(database_id, position, data_source_id)`;
  yield* sql`CREATE TABLE spaces_db_properties (
    data_source_id TEXT NOT NULL REFERENCES spaces_db_data_sources(data_source_id) ON DELETE CASCADE,
    property_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    description TEXT,
    position INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    PRIMARY KEY (data_source_id, property_id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE UNIQUE INDEX spaces_db_properties_name
    ON spaces_db_properties(data_source_id, name_key) WHERE deleted_at_ms IS NULL`;
  yield* sql`CREATE TABLE spaces_db_options (
    data_source_id TEXT NOT NULL,
    property_id TEXT NOT NULL,
    option_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    color TEXT NOT NULL,
    status_group TEXT,
    position INTEGER NOT NULL,
    PRIMARY KEY (data_source_id, property_id, option_id),
    FOREIGN KEY (data_source_id, property_id)
      REFERENCES spaces_db_properties(data_source_id, property_id) ON DELETE CASCADE
  ) WITHOUT ROWID`;
  yield* sql`CREATE UNIQUE INDEX spaces_db_options_name
    ON spaces_db_options(data_source_id, property_id, name_key)`;
  yield* sql`CREATE TABLE spaces_db_views (
    view_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces_ids(id),
    database_id TEXT NOT NULL REFERENCES spaces_db_databases(database_id),
    data_source_id TEXT NOT NULL REFERENCES spaces_db_data_sources(data_source_id),
    owner_block_id TEXT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    position INTEGER NOT NULL,
    filter TEXT,
    sorts TEXT NOT NULL DEFAULT '[]',
    grouping TEXT,
    sub_grouping TEXT,
    properties TEXT NOT NULL DEFAULT '[]',
    layout TEXT NOT NULL DEFAULT '{}',
    logical_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX spaces_db_views_database ON spaces_db_views(database_id, position, view_id)`;
  yield* sql`CREATE INDEX spaces_db_views_source ON spaces_db_views(data_source_id)`;
  yield* sql`ALTER TABLE spaces_pages ADD COLUMN data_source_id TEXT REFERENCES spaces_db_data_sources(data_source_id)`;
  yield* sql`ALTER TABLE spaces_pages ADD COLUMN row_seq INTEGER`;
  yield* sql`ALTER TABLE spaces_pages ADD COLUMN row_position INTEGER`;
  yield* sql`ALTER TABLE spaces_pages ADD COLUMN row_template INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE UNIQUE INDEX spaces_pages_row_seq
    ON spaces_pages(data_source_id, row_seq) WHERE data_source_id IS NOT NULL`;
  yield* sql`CREATE INDEX spaces_pages_rows
    ON spaces_pages(data_source_id, row_position, row_seq)
    WHERE data_source_id IS NOT NULL AND trash_batch_id IS NULL AND row_template = 0`;
  // A rowid table on purpose: rich-text values can be 16 KiB, too large for WITHOUT ROWID.
  yield* sql`CREATE TABLE spaces_db_cells (
    page_id TEXT NOT NULL REFERENCES spaces_pages(page_id) ON DELETE CASCADE,
    property_id TEXT NOT NULL,
    ord INTEGER NOT NULL DEFAULT 0,
    data_source_id TEXT NOT NULL,
    ref TEXT,
    text_key TEXT,
    text_full TEXT,
    num REAL,
    time_start INTEGER,
    time_end INTEGER,
    flags INTEGER NOT NULL DEFAULT 0,
    value TEXT,
    PRIMARY KEY (page_id, property_id, ord)
  )`;
  yield* sql`CREATE INDEX spaces_db_cells_property
    ON spaces_db_cells(data_source_id, property_id, page_id, ord)`;
  yield* sql`CREATE INDEX spaces_db_cells_ref
    ON spaces_db_cells(ref, data_source_id, property_id, page_id) WHERE ref IS NOT NULL`;
});
