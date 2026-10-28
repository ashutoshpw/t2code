import * as Effect from "effect/Effect";

import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`CREATE TABLE spaces_asset_usage (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes >= 0),
    physical_bytes INTEGER NOT NULL DEFAULT 0 CHECK(physical_bytes >= 0),
    pending_count INTEGER NOT NULL DEFAULT 0 CHECK(pending_count >= 0),
    active_count INTEGER NOT NULL DEFAULT 0 CHECK(active_count >= 0)
  )`;
  yield* sql`INSERT INTO spaces_asset_usage(singleton) VALUES (1)`;
  yield* sql`CREATE TABLE spaces_asset_callers (
    caller_id TEXT PRIMARY KEY, pending_count INTEGER NOT NULL CHECK(pending_count >= 0),
    active_count INTEGER NOT NULL CHECK(active_count >= 0)
  )`;
  yield* sql`CREATE TABLE spaces_asset_blobs (
    digest TEXT PRIMARY KEY CHECK(length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    byte_size INTEGER NOT NULL CHECK(byte_size > 0), mime_type TEXT NOT NULL, media_kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('publishing','ready','deleting','deleted')),
    generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
    physical_charged INTEGER NOT NULL DEFAULT 0 CHECK(physical_charged IN (0,1)), created_at_ms INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX spaces_asset_blob_states ON spaces_asset_blobs(state,digest)`;
  yield* sql`CREATE TABLE spaces_assets (
    asset_id TEXT PRIMARY KEY REFERENCES spaces_ids(id),
    digest TEXT NOT NULL REFERENCES spaces_asset_blobs(digest), name TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('ready','deleted')), created_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER, width INTEGER, height INTEGER
  )`;
  yield* sql`CREATE INDEX spaces_assets_digest ON spaces_assets(digest,asset_id)`;
  yield* sql`CREATE TABLE spaces_asset_uploads (
    upload_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL UNIQUE REFERENCES spaces_ids(id),
    caller_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    expected_bytes INTEGER NOT NULL CHECK(expected_bytes > 0), mime_type TEXT NOT NULL,
    media_kind TEXT NOT NULL, name TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','receiving','verified','ready','expired')),
    attempt_id TEXT, digest TEXT REFERENCES spaces_asset_blobs(digest), blob_generation INTEGER,
    width INTEGER, height INTEGER, cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_pending IN (0,1)), UNIQUE(caller_id,request_id)
  )`;
  yield* sql`CREATE INDEX spaces_asset_upload_expiry ON spaces_asset_uploads(state,expires_at_ms,upload_id)`;
  yield* sql`CREATE INDEX spaces_asset_recovery ON spaces_asset_uploads(upload_id)
    WHERE state IN ('receiving','verified') OR (state = 'ready' AND cleanup_pending = 1)`;
  yield* sql`CREATE INDEX spaces_asset_upload_digest ON spaces_asset_uploads(digest,state,upload_id)`;
});
