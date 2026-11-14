import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Peer links preview builds recorded 68-70 before main took those slots for other migrations.
// A snapshot with exactly that history drops the preview's schema so main's 68+ can run.
const PEER_LINKS_PREVIEW_HISTORY = [
  "68:PeerLinks",
  "69:PeerLinkFence",
  "70:WaitingLinkRequestIndex",
];

export const forgetPeerLinksPreviewHistory = Effect.fn("forgetPeerLinksPreviewHistory")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
    if (tables.length === 0) return;
    const tail = yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 68
    ORDER BY migration_id`;
    const history = tail.map((row) => `${row.migration_id}:${row.name}`);
    if (history.join() !== PEER_LINKS_PREVIEW_HISTORY.join()) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_waiting_link_idx`;
        yield* sql`DROP TABLE IF EXISTS peer_environment_links`;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 68`;
      }),
    );
  },
);
