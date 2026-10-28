import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`CREATE TABLE spaces_asset_reconciliation (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    format_version INTEGER NOT NULL DEFAULT 0 CHECK(format_version >= 0),
    block_cursor TEXT NOT NULL DEFAULT '', blocks_done INTEGER NOT NULL DEFAULT 0,
    history_page TEXT NOT NULL DEFAULT '', history_revision INTEGER NOT NULL DEFAULT -1,
    history_done INTEGER NOT NULL DEFAULT 0, blob_cursor TEXT NOT NULL DEFAULT '', blobs_done INTEGER NOT NULL DEFAULT 0,
    file_kind TEXT NOT NULL DEFAULT '', file_cursor TEXT NOT NULL DEFAULT '',
    assets_done INTEGER NOT NULL DEFAULT 0, staging_done INTEGER NOT NULL DEFAULT 0,
    assets_generation INTEGER NOT NULL DEFAULT 0,staging_generation INTEGER NOT NULL DEFAULT 0,
    assets_bytes INTEGER NOT NULL DEFAULT 0 CHECK(assets_bytes >= 0),
    staging_bytes INTEGER NOT NULL DEFAULT 0 CHECK(staging_bytes >= 0),
    observed_at_ms INTEGER NOT NULL DEFAULT 0,cycle_started_ms INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT INTO spaces_asset_reconciliation(singleton) VALUES (1)`;
  yield* sql`CREATE TABLE spaces_asset_reconciliation_issues (
    kind TEXT NOT NULL, entity TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(kind,entity)
  )`;
  yield* sql`CREATE TABLE spaces_asset_file_observations (
    kind TEXT NOT NULL CHECK(kind IN ('assets','staging')), name TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes >= 0), identity TEXT NOT NULL, first_seen_ms INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL, PRIMARY KEY(kind,name)
  )`;
  yield* sql`CREATE INDEX spaces_asset_attempts ON spaces_asset_uploads(attempt_id)`;
});
