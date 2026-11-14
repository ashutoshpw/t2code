import * as Effect from "effect/Effect";

import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`ALTER TABLE spaces_core ADD COLUMN revision_bytes INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE spaces_pages ADD COLUMN retained_revision_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE spaces_pages ADD COLUMN retained_revision_bytes INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE TABLE spaces_revisions (
    page_id TEXT NOT NULL REFERENCES spaces_pages(page_id),
    to_revision INTEGER NOT NULL CHECK(to_revision >= 0), mutation_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
    payload TEXT NOT NULL, logical_bytes INTEGER NOT NULL CHECK(logical_bytes > 0),
    asset_count INTEGER NOT NULL CHECK(asset_count >= 0),
    PRIMARY KEY(page_id,to_revision)
  )`;
  yield* sql`CREATE INDEX spaces_revisions_expiry ON spaces_revisions(expires_at_ms,page_id,to_revision)`;
  yield* sql`CREATE INDEX spaces_revisions_created ON spaces_revisions(created_at_ms,page_id,to_revision)`;
  yield* sql`CREATE TABLE spaces_block_asset_refs (
    block_id TEXT PRIMARY KEY REFERENCES spaces_blocks(block_id), asset_id TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX spaces_block_assets ON spaces_block_asset_refs(asset_id,block_id)`;
  yield* sql`CREATE TABLE spaces_revision_asset_refs (
    page_id TEXT NOT NULL, to_revision INTEGER NOT NULL, asset_id TEXT NOT NULL,
    PRIMARY KEY(page_id,to_revision,asset_id),
    FOREIGN KEY(page_id,to_revision) REFERENCES spaces_revisions(page_id,to_revision) ON DELETE CASCADE
  )`;
  yield* sql`CREATE INDEX spaces_revision_assets ON spaces_revision_asset_refs(asset_id,page_id,to_revision)`;
});
