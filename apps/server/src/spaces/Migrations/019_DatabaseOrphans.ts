import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

// Purely additive. `spaces_db_databases.orphaned_at_ms` already exists; a view gets its own mark,
// and a database whose purge has begun is never adopted again.
export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`ALTER TABLE spaces_db_databases ADD COLUMN purge_started_at_ms INTEGER`;
  yield* sql`ALTER TABLE spaces_db_views ADD COLUMN orphaned_at_ms INTEGER`;
});
