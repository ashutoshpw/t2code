import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// v0.1.1 recorded LegacyMcpIdentityRewrite as id 63, which later builds give to DropUnusedV1Projections.
// Forget the row so 63 onward run in order; the rewrite runs again as 74 and finds nothing left to change.
export const reconcileLegacyMcpIdentityMigration = Effect.fn("reconcileLegacyMcpIdentityMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
    if (tables.length === 0) return;
    yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE migration_id = 63 AND name = 'LegacyMcpIdentityRewrite'
  `;
  },
);
