import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`CREATE TABLE spaces_library_sequence (singleton INTEGER PRIMARY KEY CHECK(singleton=1), sequence INTEGER NOT NULL)`;
  yield* sql`INSERT INTO spaces_library_sequence VALUES (1,0)`;
  yield* sql`CREATE TABLE spaces_pins (page_id TEXT PRIMARY KEY REFERENCES spaces_pages(page_id) ON DELETE CASCADE, sequence INTEGER NOT NULL)`;
  yield* sql`CREATE INDEX spaces_pins_order ON spaces_pins(sequence DESC,page_id)`;
  yield* sql`CREATE TABLE spaces_recents (page_id TEXT PRIMARY KEY REFERENCES spaces_pages(page_id) ON DELETE CASCADE, sequence INTEGER NOT NULL)`;
  yield* sql`CREATE INDEX spaces_recents_order ON spaces_recents(sequence DESC,page_id)`;
});
