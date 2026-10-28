import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`PRAGMA defer_foreign_keys = ON`;
  yield* sql`CREATE TABLE spaces_pages_next (
    page_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces_ids(id),
    space_id TEXT NOT NULL REFERENCES spaces(space_id), title TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, root_order TEXT,
    block_count INTEGER NOT NULL DEFAULT 0, block_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    retained_revision_count INTEGER NOT NULL DEFAULT 0,
    retained_revision_bytes INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT INTO spaces_pages_next SELECT * FROM spaces_pages`;
  yield* sql`DROP TABLE spaces_pages`;
  yield* sql`ALTER TABLE spaces_pages_next RENAME TO spaces_pages`;
  yield* sql`CREATE INDEX spaces_pages_root ON spaces_pages(space_id,root_order,page_id)`;
  yield* sql`CREATE TABLE spaces_page_owners (
    child_page_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces_pages(page_id),
    owner_block_id TEXT NOT NULL UNIQUE REFERENCES spaces_blocks(block_id)
  )`;
  yield* sql`CREATE INDEX spaces_blocks_page_owners ON spaces_blocks(page_id,rank,block_id)
    WHERE deleted = 0 AND json_extract(payload,'$.type') = 'child_page'`;
  const violations = yield* sql`PRAGMA foreign_key_check`;
  if (violations.length)
    return yield* new Migrator.MigrationError({
      kind: "Failed",
      message: "Spaces ownership migration has invalid references.",
    });
  // Replacing the parent table leaves SQLite's deferred violation counter stale after references resolve.
  yield* sql`PRAGMA defer_foreign_keys = OFF`;
});
