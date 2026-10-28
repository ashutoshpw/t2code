import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0001 from "./Migrations/001_Spaces.ts";
import Migration0002 from "./Migrations/002_Core.ts";
import Migration0003 from "./Migrations/003_RevisionPreimages.ts";
import Migration0004 from "./Migrations/004_PageOwners.ts";
import Migration0005 from "./Migrations/005_ReferenceIdentity.ts";
import Migration0006 from "./Migrations/006_Recovery.ts";
import Migration0007 from "./Migrations/007_Search.ts";
import Migration0008 from "./Migrations/008_Assets.ts";
import Migration0009 from "./Migrations/009_AssetReconciliation.ts";
import Migration0010 from "./Migrations/010_AssetCollection.ts";
import Migration0011 from "./Migrations/011_PageActivity.ts";
import Migration0012 from "./Migrations/012_PageLibrary.ts";
import Migration0013 from "./Migrations/013_LibraryRevisions.ts";
import * as SpacesSql from "./SpacesSql.ts";

const APPLICATION_ID = 0x53504143;
const migrationEntries = [
  [1, "Spaces", Migration0001],
  [2, "Core", Migration0002],
  [3, "RevisionPreimages", Migration0003],
  [4, "PageOwners", Migration0004],
  [5, "ReferenceIdentity", Migration0005],
  [6, "Recovery", Migration0006],
  [7, "Search", Migration0007],
  [8, "Assets", Migration0008],
  [9, "AssetReconciliation", Migration0009],
  [10, "AssetCollection", Migration0010],
  [11, "PageActivity", Migration0011],
  [12, "PageLibrary", Migration0012],
  [13, "LibraryRevisions", Migration0013],
] as const;

export class SpacesDatabaseMismatchError extends Schema.TaggedError<SpacesDatabaseMismatchError>()(
  "SpacesDatabaseMismatchError",
  { reason: Schema.Literals(["foreign-database", "migration-history"]) },
) {
  override get message() {
    return "This database is not compatible with this version of Spaces.";
  }
}

export class SpacesMigrationFailedError extends Schema.TaggedError<SpacesMigrationFailedError>()(
  "SpacesMigrationFailedError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Spaces schema initialization failed.";
  }
}

export const assertSpacesDatabase = Effect.fn("SpacesMigrations.assertDatabase")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  const [application] = yield* sql<{ readonly application_id: number }>`PRAGMA application_id`;
  const objects = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1
  `;
  if (application?.application_id === 0 && objects.length === 0) return;
  if (application?.application_id !== APPLICATION_ID) {
    return yield* new SpacesDatabaseMismatchError({ reason: "foreign-database" });
  }
  const ledger = yield* sql`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (ledger.length === 0) {
    return yield* new SpacesDatabaseMismatchError({ reason: "migration-history" });
  }
  const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id LIMIT ${migrationEntries.length + 1}
  `;
  for (const [index, row] of recorded.entries()) {
    const expected = migrationEntries[index];
    if (row.migration_id !== expected?.[0] || row.name !== expected[1]) {
      return yield* new SpacesDatabaseMismatchError({ reason: "migration-history" });
    }
  }
});

const migrate = Migrator.make({});

export const runMigrations = Effect.fn("SpacesMigrations.run")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  // Keep Migrator's generic tag inside boot; application code receives only SpacesSql.
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* assertSpacesDatabase();
      yield* sql.unsafe(`PRAGMA application_id = ${APPLICATION_ID}`);
      return yield* migrate({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            migrationEntries.map(([id, name, migration]) => [
              `${id}_${name}`,
              migration.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
            ]),
          ),
        ),
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        // Migrator makes SQL migration failures defects; readiness needs a recoverable failure.
        Effect.catchDefect((cause) =>
          cause instanceof Migrator.MigrationError
            ? Effect.fail(new SpacesMigrationFailedError({ cause }))
            : Effect.die(cause),
        ),
      );
    }),
  );
});
