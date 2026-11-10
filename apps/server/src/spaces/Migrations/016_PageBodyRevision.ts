import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`ALTER TABLE spaces_pages ADD COLUMN body_revision INTEGER NOT NULL DEFAULT 0`;
  yield* sql`UPDATE spaces_pages SET body_revision = revision`;
});
