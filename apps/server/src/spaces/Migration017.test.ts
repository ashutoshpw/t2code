import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
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
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import { canonical } from "./CorePolicy.ts";
import * as SpacesService from "./SpacesService.ts";
import * as SpacesSql from "./SpacesSql.ts";
import { env, environmentId } from "./service/Spaces.testkit.ts";
import { databaseKit } from "./service/Databases.testkit.ts";

const upTo016 = [
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
] as const;

it.layer(NodeServices.layer)("Spaces databases migration", (it) => {
  it.effect(
    "migrates a 016 database with pages, children, trash and pins and leaves them readable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-017-" });
        const dbPath = path.join(directory, "spaces.sqlite");
        const stamp = "2026-10-26T00:00:00.000Z";
        const rank = (n: number) => n.toString(16).padStart(32, "0");
        const before = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA application_id=1397768515`;
          yield* Migrator.make({})({
            loader: Migrator.fromRecord(
              Object.fromEntries(
                upTo016.map(([name, migration]) => [
                  name,
                  migration.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
                ]),
              ),
            ),
          });
          yield* sql`INSERT INTO spaces_ids(id,kind) VALUES ('root','page'),('child','page'),('owner','block'),('gone','page')`;
          yield* sql`INSERT INTO spaces_pages(page_id,space_id,title,root_order,created_at,updated_at)
          VALUES ('root','default','Root',${rank(1)},${stamp},${stamp}),
          ('child','default','Child',NULL,${stamp},${stamp})`;
          const payload = canonical({
            id: "owner",
            type: "child_page",
            version: 1,
            parentId: null,
            order: rank(1),
            content: {},
          });
          yield* sql`INSERT INTO spaces_blocks(block_id,page_id,parent_id,rank,payload,logical_bytes)
          VALUES ('owner','root',NULL,${rank(1)},${payload},${Buffer.byteLength(payload, "utf8")})`;
          yield* sql`INSERT INTO spaces_page_owners(child_page_id,owner_block_id) VALUES ('child','owner')`;
          yield* sql`UPDATE spaces_pages SET block_count=1,block_bytes=${Buffer.byteLength(payload, "utf8")} WHERE page_id='root'`;
          const origin = canonical({
            spaceId: "default",
            rootOrder: rank(2),
            ownerBlockId: null,
            ownerPageId: null,
            parentId: null,
            rank: null,
          });
          yield* sql`INSERT INTO spaces_pages(page_id,space_id,title,root_order,created_at,updated_at,trash_batch_id,trash_root_id,trashed_at_ms,trash_origin)
          VALUES ('gone','default','Gone',NULL,${stamp},${stamp},'batch','gone',5,${origin})`;
          yield* sql`INSERT INTO spaces_pins(page_id,sequence) VALUES ('root',1)`;
          yield* sql`UPDATE spaces_library_sequence SET sequence=1,pins_revision=1`;
          return yield* sql`SELECT * FROM spaces_pages ORDER BY page_id`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })), Effect.scoped);

        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const library = yield* service.listSpaces(env);
          const roots = yield* service.listPages({ ...env, spaceId: library.defaultSpaceId });
          assert.deepEqual(
            roots.items.map((page) => [page.id, page.location?.kind]),
            [["root", "root"]],
          );
          const children = yield* service.listPages({
            ...env,
            spaceId: library.defaultSpaceId,
            parentPageId: C.SpacePageId.make("root"),
          });
          assert.deepEqual(
            children.items.map((page) => [page.id, page.location?.kind, page.row]),
            [["child", "child", undefined]],
          );
          assert.deepEqual(
            (yield* service.listTrash(env)).items.map((entry) => entry.pageId),
            ["gone"],
          );
          assert.deepEqual(
            (yield* service.listPins(env)).items.map((item) => item.page.id),
            ["root"],
          );
          assert.deepEqual(
            (yield* service.listAllPages(env)).items.map((item) => item.page.id).sort(),
            ["child", "root"],
          );
          // The database feature works on top of the migrated file.
          const kit = databaseKit(
            service,
            { ...env, receiptEpoch: library.mutationAdmission.epoch },
            library.defaultSpaceId,
          );
          const created = yield* kit.create("After migration", {
            appendToPageId: C.SpacePageId.make("root"),
          });
          assert.isTrue((yield* kit.get(created.databaseId)).database.live);
        }).pipe(
          Effect.provide(
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
            ),
          ),
        );

        const after = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            pages:
              yield* sql`SELECT * FROM spaces_pages WHERE page_id IN ('root','child','gone') ORDER BY page_id`,
            ledger:
              yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 17`,
          };
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        const movedByCreate = new Set([
          "updated_at",
          "revision",
          "body_revision",
          "block_count",
          "block_bytes",
          "retained_revision_count",
          "retained_revision_bytes",
        ]);
        assert.deepEqual(after.ledger, [{ migration_id: 17, name: "Databases" }]);
        for (const [index, page] of after.pages.entries()) {
          assert.isNull(page.data_source_id);
          assert.isNull(page.row_seq);
          assert.isNull(page.row_position);
          assert.equal(page.row_template, 0);
          const original = before[index]!;
          for (const key of Object.keys(original))
            // The root page is edited by the database created above, so its counters moved.
            if (!movedByCreate.has(key))
              assert.deepEqual(page[key], original[key], `${page.page_id}.${key}`);
        }
      }),
  );
});
