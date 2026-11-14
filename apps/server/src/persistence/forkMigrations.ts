import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0001 from "./ForkMigrations/001_LegacyMcpIdentityRewrite.ts";

// Fork-owned migrations have their own ledger so they never occupy an id in upstream's chain.
const FORK_MIGRATIONS_TABLE = "t2_fork_migrations";

const forkMigrationEntries = [[1, "LegacyMcpIdentityRewrite", Migration0001]] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const FIRST_FORK_NUMBERED_ID = 74;

// Ids the fork shipped before it left upstream's sequence, keyed by recorded id. A null target is a
// fork-only migration that now lives in the fork ledger.
const legacyForkRecords: ReadonlyArray<readonly [number, string, number | null]> = [
  [63, "LegacyMcpIdentityRewrite", null],
  [74, "LegacyMcpIdentityRewrite", null],
  [75, "ExcludeAttachmentPlaceholdersFromSearch", 74],
  [76, "SubagentDeliveryState", 75],
  [77, "ProjectionProjectsPinArchive", 76],
  [78, "RepairBooleanSettledOverride", 77],
  [79, "DropOrchestrationEventCorrelationIndex", 78],
  [80, "DelegatedRecoveryIndexes", 79],
  [81, "ScheduledTaskThreadMode", 80],
];

/** A recorded main-ledger row as this build numbers it; undefined for fork-only rows. */
export const normalizeLegacyForkRecord = (row: {
  readonly id: number;
  readonly name: string;
}): { readonly id: number; readonly name: string } | undefined => {
  const legacy = legacyForkRecords.find(([id, name]) => id === row.id && name === row.name);
  if (legacy === undefined) return row;
  return legacy[2] === null ? undefined : { id: legacy[2], name: row.name };
};

// Rewrites a fork-numbered ledger to upstream numbering by (id, name). Rows matching nothing are
// left for the later guard. Runs before the migrator; idempotent.
export const reconcileForkMigrations = Effect.fn("reconcileForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return;
      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 63
      `;
      const forkOwned = rows.filter((row) =>
        legacyForkRecords.some(
          ([id, name, target]) => target === null && id === row.migration_id && name === row.name,
        ),
      );
      // The shifted 75..81 block is recognised by the fork's own id-74 row.
      const shifted = forkOwned.some((row) => row.migration_id === FIRST_FORK_NUMBERED_ID);
      const moving = rows.filter((row) => {
        const legacy = legacyForkRecords.find(
          ([id, name]) => id === row.migration_id && name === row.name,
        );
        if (legacy === undefined) return false;
        return legacy[2] === null || (shifted && legacy[0] >= FIRST_FORK_NUMBERED_ID);
      });
      if (moving.length === 0) return;

      yield* sql`
        CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATIONS_TABLE)} (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;
      if (forkOwned.length > 0) {
        yield* sql`
          INSERT OR IGNORE INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, name)
          VALUES (1, 'LegacyMcpIdentityRewrite')
        `;
      }
      for (const row of moving) {
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${row.migration_id}`;
      }
      for (const row of moving) {
        const target = normalizeLegacyForkRecord({ id: row.migration_id, name: row.name });
        if (target === undefined) continue;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${target.id}, ${target.name})
        `;
      }
    }),
  );
});

const runFork = Migrator.make({});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  return yield* runFork({
    table: FORK_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
});
