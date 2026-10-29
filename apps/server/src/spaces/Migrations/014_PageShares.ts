import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`CREATE TABLE spaces_page_shares (
    page_id TEXT PRIMARY KEY NOT NULL REFERENCES spaces_pages(page_id) ON DELETE CASCADE,
    share_id TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`;
});
