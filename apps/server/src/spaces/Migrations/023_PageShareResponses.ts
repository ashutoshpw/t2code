import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`ALTER TABLE spaces_page_shares ADD COLUMN accept_responses INTEGER NOT NULL DEFAULT 0`;
});
