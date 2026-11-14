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
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as SpacesService from "./SpacesService.ts";
import * as SpacesSql from "./SpacesSql.ts";
import { env, environmentId } from "./service/Spaces.testkit.ts";
import { databaseKit, pid } from "./service/Databases.testkit.ts";

const upTo017 = [
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

it.layer(NodeServices.layer)("Spaces computed properties migration", (it) => {
  it.effect("adds the computed column, the dependency table and the queue to a 017 database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-018-" });
      const dbPath = path.join(directory, "spaces.sqlite");
      yield* sqlite(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA application_id=1397768515`;
          yield* Migrator.make({})({
            loader: Migrator.fromRecord(
              Object.fromEntries(
                upTo017.map(([name, migration]) => [
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
          return {
            ledger:
              yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 18`,
            columns: (yield* sql<{
              readonly name: string;
            }>`PRAGMA table_info(spaces_db_properties)`).map((column) => column.name),
            deps: (yield* sql<{
              readonly name: string;
            }>`PRAGMA table_info(spaces_db_computed_deps)`).map((column) => column.name),
            dirty: (yield* sql<{
              readonly name: string;
            }>`PRAGMA table_info(spaces_db_computed_dirty)`).map((column) => column.name),
            indexes: (yield* sql<{
              readonly name: string;
            }>`SELECT name FROM sqlite_master WHERE type = 'index'
              AND name LIKE 'spaces_db_computed_%'`).map((index) => index.name),
          };
        }),
      );
      assert.deepEqual(after.ledger, [{ migration_id: 18, name: "ComputedProperties" }]);
      assert.include(after.columns, "computed");
      assert.deepEqual(after.deps, [
        "data_source_id",
        "property_id",
        "via_property_id",
        "dep_data_source_id",
        "dep_property_id",
      ]);
      assert.deepEqual(after.dirty, ["page_id", "data_source_id"]);
      assert.includeMembers(after.indexes, [
        "spaces_db_computed_deps_dep",
        "spaces_db_computed_dirty_source",
      ]);
    }),
  );

  it.effect("compiles a formula that predates the column on the first row write", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-018-" });
      const dbPath = path.join(directory, "spaces.sqlite");
      const created = yield* Effect.gen(function* () {
        const service = yield* SpacesService.SpacesService;
        const library = yield* service.listSpaces(env);
        const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
        const page = yield* service.createPage({
          ...common,
          mutationId: "page",
          spaceId: library.defaultSpaceId,
          baseRootOrderRevision: 0,
          title: "Page",
        });
        if (page.status !== "saved") return yield* Effect.die("Expected a saved page");
        const kit = databaseKit(service, common, page.page.spaceId);
        const database = yield* kit.create("Old", {
          appendToPageId: page.page.id,
          properties: [
            { id: pid("num0001"), name: "N", type: "number" },
            {
              id: pid("frm0001"),
              name: "F",
              type: "formula",
              config: { expression: 'prop("N") + 1' },
            },
          ],
        });
        return database.dataSourceId;
      }).pipe(Effect.provide(serviceLayer(dbPath)));
      // As a database from before the column: no stored definition, no dependency rows.
      yield* sqlite(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE spaces_db_properties SET computed = NULL WHERE property_id = 'frm0001'`;
          yield* sql`DELETE FROM spaces_db_computed_deps`;
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* SpacesService.SpacesService;
        const library = yield* service.listSpaces(env);
        const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
        const row = yield* service.createRows({
          ...common,
          mutationId: "first-write",
          dataSourceId: created,
          rows: [{ title: "R", cells: { num0001: 41 } }],
        });
        const read = yield* service.getDatabaseRows({ ...env, pageId: row.rows[0]!.pageId });
        assert.deepEqual(read.row.cells["frm0001"], { type: "number", value: 42 });
      }).pipe(Effect.provide(serviceLayer(dbPath)));
    }),
  );
});
