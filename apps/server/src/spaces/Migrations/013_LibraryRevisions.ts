import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`ALTER TABLE spaces_library_sequence ADD COLUMN pins_revision INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE spaces_library_sequence ADD COLUMN recents_revision INTEGER NOT NULL DEFAULT 0`;
  yield* sql`UPDATE spaces_library_sequence SET pins_revision=sequence, recents_revision=sequence`;
});
