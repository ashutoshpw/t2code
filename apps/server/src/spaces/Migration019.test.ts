import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";
import * as TestClock from "effect/testing/TestClock";

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
import Migration0014 from "./Migrations/014_PageShares.ts";
import Migration0015 from "./Migrations/015_PageIcon.ts";
import Migration0016 from "./Migrations/016_PageBodyRevision.ts";
import Migration0017 from "./Migrations/017_Databases.ts";
import Migration0018 from "./Migrations/018_ComputedProperties.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as SpacesService from "./SpacesService.ts";
import * as SpacesSql from "./SpacesSql.ts";
import { env, environmentId } from "./service/Spaces.testkit.ts";

const upTo018 = [
  ["1_Spaces", Migration0001],
  ["2_Core", Migration0002],
  ["3_RevisionPreimages", Migration0003],
  ["4_PageOwners", Migration0004],
  ["5_ReferenceIdentity", Migration0005],
  ["6_Recovery", Migration0006],
  ["7_Search", Migration0007],
  ["8_Assets", Migration0008],
  ["9_AssetReconciliation", Migration0009],
  ["10_AssetCollection", Migration0010],
  ["11_PageActivity", Migration0011],
  ["12_PageLibrary", Migration0012],
  ["13_LibraryRevisions", Migration0013],
  ["14_PageShares", Migration0014],
  ["15_PageIcon", Migration0015],
  ["16_PageBodyRevision", Migration0016],
  ["17_Databases", Migration0017],
  ["18_ComputedProperties", Migration0018],
] as const;

const serviceLayer = (dbPath: string) =>
  Layer.mergeAll(
    SpacesService.layerFromPath(dbPath).pipe(
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provideMerge(Settings.layerTest({ spacesEnabled: true })),
    ),
    TestClock.layer(),
  );

const sqlite = <A, E>(dbPath: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })), Effect.scoped);

it.layer(NodeServices.layer)("Spaces database orphans migration", (it) => {
  it.effect("adds the purge mark and the view mark to an 018 database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-019-" });
      const dbPath = path.join(directory, "spaces.sqlite");
      yield* sqlite(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA application_id=1397768515`;
          yield* Migrator.make({})({
            loader: Migrator.fromRecord(
              Object.fromEntries(
                upTo018.map(([name, migration]) => [
                  name,
                  migration.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
                ]),
              ),
            ),
          });
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* SpacesService.SpacesService;
        yield* service.listSpaces(env);
      }).pipe(Effect.provide(serviceLayer(dbPath)));
      const after = yield* sqlite(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const names = (table: string) =>
            Effect.map(
              sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`,
              (columns) => columns.map((column) => column.name),
            );
          return {
            ledger:
              yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 19`,
            databases: yield* names("spaces_db_databases"),
            views: yield* names("spaces_db_views"),
          };
        }),
      );
      assert.deepEqual(after.ledger, [{ migration_id: 19, name: "DatabaseOrphans" }]);
      assert.includeMembers(after.databases, ["orphaned_at_ms", "purge_started_at_ms"]);
      assert.include(after.views, "orphaned_at_ms");
    }),
  );
});
