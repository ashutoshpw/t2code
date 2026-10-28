import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`CREATE TABLE spaces_search_docs (
    doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT UNIQUE NOT NULL, page_id TEXT NOT NULL, block_id TEXT,
    text TEXT NOT NULL, text_json_bytes INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE spaces_search_build (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    phase TEXT NOT NULL, after_id TEXT NOT NULL DEFAULT ''
  )`;
  yield* sql`INSERT INTO spaces_search_build(singleton,phase) VALUES(1,'pages')`;
  yield* sql`CREATE TRIGGER spaces_search_page_delete AFTER DELETE ON spaces_pages BEGIN
    DELETE FROM spaces_search_docs WHERE source_id=old.page_id;
  END`;
  yield* sql`CREATE TRIGGER spaces_search_block_delete AFTER DELETE ON spaces_blocks BEGIN
    DELETE FROM spaces_search_docs WHERE source_id=old.block_id;
  END`;
  yield* sql`CREATE TRIGGER spaces_search_block_move AFTER UPDATE OF page_id ON spaces_blocks
    WHEN old.page_id IS NOT new.page_id BEGIN
    UPDATE spaces_search_docs SET page_id=new.page_id WHERE source_id=new.block_id;
  END`;
  const created = yield* sql`CREATE VIRTUAL TABLE spaces_search_fts USING fts5(
    text, content='spaces_search_docs', content_rowid='doc_id', tokenize='unicode61'
  )`.pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) =>
        Predicate.hasProperty(error.reason.cause, "message") &&
        error.reason.cause.message === "no such module: fts5",
      () => Effect.succeed(false),
    ),
  );
  if (!created) {
    yield* sql`UPDATE spaces_search_build SET phase='unsupported' WHERE singleton=1`;
    return;
  }
  yield* sql`CREATE TRIGGER spaces_search_insert AFTER INSERT ON spaces_search_docs BEGIN
    INSERT INTO spaces_search_fts(rowid,text) VALUES(new.doc_id,new.text);
  END`;
  yield* sql`CREATE TRIGGER spaces_search_delete AFTER DELETE ON spaces_search_docs BEGIN
    INSERT INTO spaces_search_fts(spaces_search_fts,rowid,text) VALUES('delete',old.doc_id,old.text);
  END`;
  yield* sql`CREATE TRIGGER spaces_search_update AFTER UPDATE OF text ON spaces_search_docs
    WHEN old.text IS NOT new.text BEGIN
    INSERT INTO spaces_search_fts(spaces_search_fts,rowid,text) VALUES('delete',old.doc_id,old.text);
    INSERT INTO spaces_search_fts(rowid,text) VALUES(new.doc_id,new.text);
  END`;
});
