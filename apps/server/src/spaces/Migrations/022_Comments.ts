import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

// Side tables only: a comment write never touches spaces_pages or spaces_blocks.
export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`CREATE TABLE spaces_comment_pages (
    page_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces_pages(page_id) ON DELETE CASCADE,
    comment_revision INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE spaces_comment_threads (
    thread_id TEXT PRIMARY KEY NOT NULL,
    page_id TEXT NOT NULL REFERENCES spaces_pages(page_id) ON DELETE CASCADE,
    block_id TEXT NOT NULL,
    anchor TEXT NOT NULL CHECK (json_valid(anchor)),
    resolved_at TEXT,
    resolved_by TEXT CHECK (resolved_by IS NULL OR json_valid(resolved_by)),
    created_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    next_ordinal INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX spaces_comment_threads_page
    ON spaces_comment_threads(page_id, created_at, thread_id)`;
  yield* sql`CREATE TABLE spaces_comments (
    comment_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES spaces_comment_threads(thread_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    author TEXT NOT NULL CHECK (json_valid(author)),
    body TEXT NOT NULL CHECK (json_valid(body)),
    created_at TEXT NOT NULL,
    edited_at TEXT,
    UNIQUE (thread_id, ordinal)
  )`;
  yield* sql`CREATE TABLE spaces_comment_dispatches (
    comment_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces_comments(comment_id) ON DELETE CASCADE,
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('edit','message')),
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX spaces_comment_dispatches_active ON spaces_comment_dispatches(run_id)
    WHERE status IN ('queued','running')`;
});
