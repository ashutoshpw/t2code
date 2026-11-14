import * as Effect from "effect/Effect";

import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`CREATE TABLE spaces_core (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), environment_id TEXT,
    catalog_revision INTEGER NOT NULL DEFAULT 0, observed_time_ms INTEGER NOT NULL DEFAULT 0,
    active_epoch TEXT, receipt_rows INTEGER NOT NULL DEFAULT 0, receipt_bytes INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT INTO spaces_core (singleton) VALUES (1)`;
  yield* sql`CREATE TABLE spaces_ids (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL)`;
  yield* sql`INSERT INTO spaces_ids SELECT space_id, 'space' FROM spaces`;
  yield* sql`CREATE INDEX spaces_created ON spaces (created_at, space_id)`;
  yield* sql`CREATE TABLE spaces_pages (
    page_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces_ids(id),
    space_id TEXT NOT NULL REFERENCES spaces(space_id), title TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, root_order TEXT NOT NULL,
    block_count INTEGER NOT NULL DEFAULT 0, block_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX spaces_pages_root ON spaces_pages (space_id, root_order, page_id)`;
  yield* sql`CREATE TABLE spaces_blocks (
    block_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces_ids(id),
    page_id TEXT NOT NULL REFERENCES spaces_pages(page_id), parent_id TEXT,
    rank TEXT NOT NULL, payload TEXT NOT NULL, logical_bytes INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)), merged_into TEXT
  )`;
  yield* sql`CREATE INDEX spaces_blocks_children ON spaces_blocks (page_id, deleted, parent_id, rank, block_id)`;
  yield* sql`CREATE TABLE spaces_epochs (
    epoch TEXT PRIMARY KEY NOT NULL, accepts_until INTEGER NOT NULL, retain_until INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX spaces_epochs_expiry ON spaces_epochs (retain_until, epoch)`;
  yield* sql`CREATE TABLE spaces_receipts (
    mutation_id TEXT PRIMARY KEY NOT NULL, epoch TEXT NOT NULL REFERENCES spaces_epochs(epoch),
    fingerprint TEXT NOT NULL, payload TEXT NOT NULL, logical_bytes INTEGER NOT NULL,
    retain_until INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX spaces_receipts_expiry ON spaces_receipts (retain_until, mutation_id)`;
  yield* sql`CREATE INDEX spaces_receipts_epoch ON spaces_receipts (epoch)`;
});
