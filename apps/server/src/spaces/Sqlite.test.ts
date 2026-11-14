// @effect-diagnostics nodeBuiltinImport:off -- subprocess fixture leaves committed WAL uncheckpointed.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";

import Migration0001 from "./Migrations/001_Spaces.ts";
import Migration0002 from "./Migrations/002_Core.ts";
import Migration0003 from "./Migrations/003_RevisionPreimages.ts";
import Migration0004 from "./Migrations/004_PageOwners.ts";
import Migration0005 from "./Migrations/005_ReferenceIdentity.ts";
import Migration0006 from "./Migrations/006_Recovery.ts";
import Migration0007 from "./Migrations/007_Search.ts";
import Migration0008 from "./Migrations/008_Assets.ts";
import Migration0009 from "./Migrations/009_AssetReconciliation.ts";

import * as ChatSqlite from "../persistence/Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import * as Receipts from "./Receipts.ts";
import * as SpacesService from "./SpacesService.ts";
import * as Settings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { canonical } from "./CorePolicy.ts";
import * as SpacesSql from "./SpacesSql.ts";
import * as Sqlite from "./Sqlite.ts";
import * as Tools from "./SpacesDatabaseTools.ts";

const decodeCoreRequest = Schema.decodeEffect(C.SpaceMutationRequest);
const decodeCoreReceipt = Schema.decodeUnknownEffect(C.SpaceMutationReceipt);

it.effect("keeps Spaces and chat connections, transactions, and migration ledgers separate", () =>
  Effect.gen(function* () {
    const chat = yield* SqlClient.SqlClient;
    const spaces = yield* SpacesSql.SpacesSql;
    yield* chat`CREATE TABLE connection_probe (value TEXT)`;
    yield* spaces`CREATE TABLE connection_probe (value TEXT)`;
    yield* chat`INSERT INTO connection_probe VALUES ('chat')`;
    yield* spaces`INSERT INTO connection_probe VALUES ('spaces')`;

    const failure = yield* spaces
      .withTransaction(
        Effect.gen(function* () {
          yield* spaces`INSERT INTO connection_probe VALUES ('rollback')`;
          yield* chat.withTransaction(chat`INSERT INTO connection_probe VALUES ('independent')`);
          return yield* Effect.fail("rollback Spaces only");
        }),
      )
      .pipe(Effect.flip);

    assert.equal(failure, "rollback Spaces only");
    assert.deepEqual(yield* chat`SELECT value FROM connection_probe ORDER BY value`, [
      { value: "chat" },
      { value: "independent" },
    ]);
    assert.deepEqual(yield* spaces`SELECT value FROM connection_probe`, [{ value: "spaces" }]);
    assert.deepEqual(yield* spaces`SELECT migration_id, name FROM effect_sql_migrations`, [
      { migration_id: 1, name: "Spaces" },
      { migration_id: 2, name: "Core" },
      { migration_id: 3, name: "RevisionPreimages" },
      { migration_id: 4, name: "PageOwners" },
      { migration_id: 5, name: "ReferenceIdentity" },
      { migration_id: 6, name: "Recovery" },
      { migration_id: 7, name: "Search" },
      { migration_id: 8, name: "Assets" },
      { migration_id: 9, name: "AssetReconciliation" },
      { migration_id: 10, name: "AssetCollection" },
    ]);
    assert.equal(
      (yield* chat`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`)[0]?.name,
      "OrchestrationEvents",
    );
    assert.deepEqual(yield* chat`SELECT name FROM sqlite_schema WHERE name = 'spaces'`, []);
    assert.deepEqual(
      yield* spaces`SELECT name FROM sqlite_schema WHERE name = 'orchestration_events'`,
      [],
    );
  }).pipe(Effect.provide(Layer.merge(ChatSqlite.layerMemory, Sqlite.layerMemory))),
);

it.effect("exposes only SpacesSql when acquired without chat persistence", () =>
  Effect.gen(function* () {
    assert.isTrue(Option.isNone(yield* Effect.serviceOption(SqlClient.SqlClient)));
    const spaces = yield* SpacesSql.SpacesSql;
    assert.equal((yield* spaces`SELECT COUNT(*) AS count FROM spaces`)[0]?.count, 1);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("rolls back a failed schema migration together with its ledger entry", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA application_id = 1397768515`;
    yield* sql`
      CREATE TABLE effect_sql_migrations (
        migration_id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `;
    yield* sql`CREATE TABLE retained (value TEXT)`;
    yield* sql`INSERT INTO retained VALUES ('keep')`;
    yield* sql`CREATE INDEX spaces_one_default ON retained (value)`;

    const failure = yield* runMigrations().pipe(
      Effect.provideService(SpacesSql.SpacesSql, sql),
      Effect.flip,
    );

    assert.equal(failure._tag, "SpacesMigrationFailedError");
    assert.deepEqual(yield* sql`SELECT name FROM sqlite_schema WHERE name = 'spaces'`, []);
    assert.deepEqual(yield* sql`SELECT migration_id FROM effect_sql_migrations`, []);
    assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "keep" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.layer(NodeServices.layer)("Spaces file persistence", (it) => {
  it.effect.each([7, 8, 9])(
    "upgrades accepted storage checkpoint%s to asset reconciliation without changing nested content",
    (checkpoint) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-assets-upgrade-" });
        const dbPath = path.join(directory, "spaces.sqlite");
        const readExisting = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            spaces: yield* sql`SELECT * FROM spaces ORDER BY space_id`,
            ids: yield* sql`SELECT * FROM spaces_ids ORDER BY id`,
            pages: yield* sql`SELECT * FROM spaces_pages ORDER BY page_id`,
            blocks: yield* sql`SELECT * FROM spaces_blocks ORDER BY block_id`,
            owners: yield* sql`SELECT * FROM spaces_page_owners ORDER BY child_page_id`,
          };
        });
        const before = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA application_id=1397768515`;
          yield* Migrator.make({})({
            loader: Migrator.fromRecord({
              "1_Spaces": Migration0001.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
              "2_Core": Migration0002.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
              "3_RevisionPreimages": Migration0003.pipe(
                Effect.provideService(SpacesSql.SpacesSql, sql),
              ),
              "4_PageOwners": Migration0004.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
              "5_ReferenceIdentity": Migration0005.pipe(
                Effect.provideService(SpacesSql.SpacesSql, sql),
              ),
              "6_Recovery": Migration0006.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
              "7_Search": Migration0007.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
              ...(checkpoint === 9
                ? {
                    "9_AssetReconciliation": Migration0009.pipe(
                      Effect.provideService(SpacesSql.SpacesSql, sql),
                    ),
                  }
                : {}),
              ...(checkpoint >= 8
                ? {
                    "8_Assets": Migration0008.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
                  }
                : {}),
            }),
          });
          yield* sql`INSERT INTO spaces_ids(id,kind) VALUES ('parent','page'),('child','page'),('owner','block')`;
          yield* sql`INSERT INTO spaces_pages(page_id,space_id,title,root_order,created_at,updated_at)
          VALUES ('parent','default','Parent','00000000000000000000000000000001','1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z'),
          ('child','default','Child',NULL,'1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z')`;
          const payload = canonical({
            id: "owner",
            type: "child_page",
            version: 1,
            parentId: null,
            order: "00000000000000000000000000000001",
            content: { pageId: "child" },
          });
          yield* sql`INSERT INTO spaces_blocks(block_id,page_id,parent_id,rank,payload,logical_bytes)
          VALUES ('owner','parent',NULL,'00000000000000000000000000000001',${payload},${Buffer.byteLength(payload, "utf8")})`;
          yield* sql`INSERT INTO spaces_page_owners(child_page_id,owner_block_id) VALUES ('child','owner')`;
          yield* sql`UPDATE spaces_pages SET block_count=1,block_bytes=${Buffer.byteLength(payload, "utf8")} WHERE page_id='parent'`;
          return yield* readExisting;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })), Effect.scoped);
        if (checkpoint === 9) {
          const original = yield* fs.readFile(dbPath);
          const tools = yield* Tools.SpacesDatabaseTools.pipe(Effect.provide(Tools.layer));
          const report = yield* tools.inspect(dbPath);
          assert.isFalse(report?.assetAccounting?.reconciliation.gcEnabled);
          assert.isFalse(report?.assetAccounting?.reconciliation.gcPending);
          assert.equal(Buffer.compare(original, yield* fs.readFile(dbPath)), 0);
        }
        for (const _acquisition of [1, 2])
          yield* Effect.gen(function* () {
            const sql = yield* SpacesSql.SpacesSql;
            assert.deepEqual(
              yield* readExisting.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
              before,
            );
            assert.deepEqual(yield* sql`SELECT * FROM spaces_asset_usage`, [
              {
                singleton: 1,
                reserved_bytes: 0,
                physical_bytes: 0,
                pending_count: 0,
                active_count: 0,
              },
            ]);
            assert.deepEqual(
              yield* sql`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id=8`,
              [{ migration_id: 8, name: "Assets" }],
            );
            assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
          }).pipe(Effect.provide(Sqlite.layerFromPath(dbPath)), Effect.scoped);
      }),
  );

  it.effect(
    "upgrades legacy tombstones without a bulk rewrite and bounds identity cleanup and long-chain compression",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-identity-upgrade-" });
        const dbPath = path.join(directory, "spaces.sqlite");
        const environmentId = EnvironmentId.make("legacy-identities");
        const liveBlock = {
          id: "legacy-survivor",
          parentId: null,
          order: "00000000000000000000000000000001",
          type: "paragraph",
          version: 1,
          content: { runs: [] },
        };
        const livePayload = JSON.stringify(liveBlock);
        const ids = Array.from({ length: 96 }, (_, i) => `legacy-${String(i).padStart(3, "0")}`);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA application_id=1397768515`;
          yield* Migrator.make({})({
            loader: Migrator.fromRecord({
              "1_Spaces": Migration0001.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
              "2_Core": Migration0002.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
              "3_RevisionPreimages": Migration0003.pipe(
                Effect.provideService(SpacesSql.SpacesSql, sql),
              ),
              "4_PageOwners": Migration0004.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
            }),
          });
          yield* sql`INSERT INTO spaces_ids(id,kind) VALUES ('legacy-page','page'),(${liveBlock.id},'block')`;
          yield* sql`INSERT INTO spaces_pages(page_id,space_id,title,root_order,created_at,updated_at) VALUES ('legacy-page','default','Legacy','00000000000000000000000000000001','1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z')`;
          let bytes = Buffer.byteLength(livePayload, "utf8");
          yield* sql`INSERT INTO spaces_blocks(block_id,page_id,parent_id,rank,payload,logical_bytes) VALUES (${liveBlock.id},'legacy-page',NULL,${liveBlock.order},${livePayload},${bytes})`;
          for (const [i, id] of ids.entries()) {
            const target = ids[i + 1] ?? liveBlock.id;
            const payload = JSON.stringify({ id, pageId: "legacy-page", mergedInto: target });
            const logical = Buffer.byteLength(payload, "utf8");
            yield* sql`INSERT INTO spaces_ids(id,kind) VALUES (${id},'block')`;
            yield* sql`INSERT INTO spaces_blocks(block_id,page_id,parent_id,rank,payload,logical_bytes,deleted,merged_into) VALUES (${id},'legacy-page',NULL,${liveBlock.order},${payload},${logical},1,${target})`;
            bytes += logical;
          }
          yield* sql`UPDATE spaces_pages SET block_count=97,block_bytes=${bytes} WHERE page_id='legacy-page'`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        yield* Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          assert.equal((yield* sql`SELECT COUNT(*) AS n FROM spaces_ids WHERE deleted=1`)[0]?.n, 0);
          assert.equal(
            (yield* sql`SELECT COUNT(*) AS n FROM spaces_blocks WHERE deleted=1`)[0]?.n,
            96,
          );
        }).pipe(Effect.provide(Sqlite.layerFromPath(dbPath)));
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const reference = {
            environmentId,
            target: { kind: "block", blockId: C.SpaceBlockId.make(ids[0]!) },
          };
          assert.deepEqual(yield* service.resolveReference(reference), { status: "unavailable" });
          let remaining = 46;
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.equal(
              (yield* sql`SELECT COUNT(*) AS n FROM spaces_blocks WHERE deleted=1`)[0]?.n,
              remaining,
            );
            assert.equal((yield* sql`SELECT block_count FROM spaces_pages`)[0]?.block_count, 47);
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          for (let pass = 0; pass < 16; pass++) {
            yield* service.getPage({ environmentId, pageId: "legacy-page" });
            const count = yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const count = Number(
                (yield* sql`SELECT COUNT(*) AS n FROM spaces_blocks WHERE deleted=1`)[0]?.n,
              );
              assert.isAtMost(remaining - count, 50);
              assert.isAtLeast(remaining - count, 0);
              return count;
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
            remaining = count;
          }
          const resolved = yield* service.resolveReference(reference);
          assert.equal(resolved.status, "merged");
          if (resolved.status === "merged") {
            assert.equal(resolved.blockId, liveBlock.id);
            assert.equal(resolved.page.id, "legacy-page");
          }
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.equal((yield* sql`SELECT COUNT(*) AS n FROM spaces_ids`)[0]?.n, 99);
            assert.equal(
              (yield* sql`SELECT COUNT(*) AS n FROM spaces_ids WHERE deleted=1`)[0]?.n,
              96,
            );
            assert.equal((yield* sql`SELECT COUNT(*) AS n FROM spaces_blocks`)[0]?.n, 1);
            assert.deepEqual(
              yield* sql`SELECT block_count,block_bytes,revision FROM spaces_pages`,
              [
                {
                  block_count: 1,
                  block_bytes: Buffer.byteLength(livePayload, "utf8"),
                  revision: 0,
                },
              ],
            );
            assert.deepEqual(yield* sql`SELECT * FROM spaces_revisions`, []);
            assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        }).pipe(
          Effect.provide(
            SpacesService.layerFromPath(dbPath).pipe(
              Layer.provide(
                Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
                  getEnvironmentId: Effect.succeed(environmentId),
                }),
              ),
              Layer.provide(Settings.layerTest({ spacesEnabled: true })),
            ),
          ),
        );
      }),
  );

  it.effect(
    "upgrades v1 preimages and exactly replays a legacy page receipt without inventing its location",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-owners-upgrade-" });
        const dbPath = path.join(directory, "spaces.sqlite");
        const environmentId = EnvironmentId.make("legacy-environment");
        const old = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA application_id=1397768515`;
          yield* Migrator.make({})({
            loader: Migrator.fromRecord({
              "1_Spaces": Migration0001.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
              "2_Core": Migration0002.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
              "3_RevisionPreimages": Migration0003.pipe(
                Effect.provideService(SpacesSql.SpacesSql, sql),
              ),
            }),
          });
          yield* sql`INSERT INTO spaces_ids VALUES ('legacy-page','page')`;
          yield* sql`INSERT INTO spaces_pages(page_id,space_id,title,root_order,created_at,updated_at) VALUES ('legacy-page','default','Legacy','00000000000000000000000000000001','1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z')`;
          yield* sql`UPDATE spaces SET root_order_revision=1 WHERE space_id='default'`;
          yield* sql`INSERT INTO spaces_epochs VALUES ('legacy-epoch',86400000,691200000)`;
          const request = yield* decodeCoreRequest({
            operation: "createPage",
            input: {
              environmentId,
              mutationId: "legacy-create",
              receiptEpoch: "legacy-epoch",
              spaceId: "default",
              baseRootOrderRevision: 0,
              title: "Legacy",
            },
          });
          const [space] = yield* sql`SELECT * FROM spaces WHERE space_id='default'`;
          const receipt = yield* decodeCoreReceipt({
            operation: "createPage",
            result: {
              status: "saved",
              mutationId: "legacy-create",
              receiptEpoch: "legacy-epoch",
              page: {
                id: "legacy-page",
                spaceId: "default",
                title: "Legacy",
                revision: 0,
                rootOrder: "00000000000000000000000000000001",
                createdAt: "1970-01-01T00:00:00.000Z",
                updatedAt: "1970-01-01T00:00:00.000Z",
              },
              space: {
                id: "default",
                title: space!.title,
                isDefault: true,
                revision: 0,
                rootOrderRevision: 1,
                createdAt: space!.created_at,
                updatedAt: space!.updated_at,
              },
            },
          });
          yield* Receipts.store(
            request,
            receipt,
            {
              environment_id: environmentId,
              catalog_revision: 1,
              observed_time_ms: 0,
              active_epoch: "legacy-epoch",
              receipt_rows: 0,
              receipt_bytes: 0,
            },
            691200000,
          ).pipe(Effect.provideService(SpacesSql.SpacesSql, sql));
          const payload = canonical({
            version: 1,
            pageBefore: null,
            ownerBefore: null,
            blocksBefore: [],
          });
          const logical = Buffer.byteLength(
            canonical({
              pageId: "legacy-page",
              toRevision: 0,
              mutationId: "legacy-create",
              createdAtMs: 0,
              expiresAtMs: 604800000,
              payload,
              assetIds: [],
            }),
            "utf8",
          );
          yield* sql`INSERT INTO spaces_revisions VALUES ('legacy-page',0,'legacy-create',0,604800000,${payload},${logical},0)`;
          yield* sql`UPDATE spaces_pages SET retained_revision_count=1,retained_revision_bytes=${logical}`;
          yield* sql`UPDATE spaces_core SET environment_id=${environmentId},catalog_revision=1,active_epoch='legacy-epoch',revision_bytes=${logical}`;
          const retiredPayload = JSON.stringify({
            id: "legacy-retired",
            pageId: "legacy-page",
            mergedInto: null,
          });
          const retiredBytes = Buffer.byteLength(retiredPayload, "utf8");
          yield* sql`INSERT INTO spaces_ids(id,kind) VALUES ('legacy-retired','block')`;
          yield* sql`INSERT INTO spaces_blocks(block_id,page_id,parent_id,rank,payload,logical_bytes,deleted) VALUES ('legacy-retired','legacy-page',NULL,'00000000000000000000000000000001',${retiredPayload},${retiredBytes},1)`;
          yield* sql`UPDATE spaces_pages SET block_count=1,block_bytes=${retiredBytes} WHERE page_id='legacy-page'`;
          return { request, receipt, payload, logical };
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          if (old.receipt.operation !== "createPage")
            return yield* Effect.die("Expected legacy receipt");
          const replay = yield* service.createPage(old.request.input);
          assert.deepEqual(replay, old.receipt.result);
          if (replay.status !== "saved") return yield* Effect.die("Expected saved receipt");
          assert.isFalse(Object.hasOwn(replay.page, "location"));
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.equal(
              (yield* sql`SELECT deleted FROM spaces_blocks WHERE block_id='legacy-retired'`)[0]
                ?.deleted,
              1,
            );
            assert.equal(
              (yield* sql`SELECT deleted FROM spaces_ids WHERE id='legacy-retired'`)[0]?.deleted,
              0,
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          assert.equal((yield* service.getCapability(environmentId))?.version, 2);
          const current = yield* service.getPage({ environmentId, pageId: "legacy-page" });
          assert.deepEqual(current.page.location, {
            kind: "root",
            spaceId: C.SpaceId.make("default"),
            order: "00000000000000000000000000000001",
          });
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepEqual(yield* sql`SELECT payload,logical_bytes FROM spaces_revisions`, [
              { payload: old.payload, logical_bytes: old.logical },
            ]);
            assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          yield* service.updatePage({
            environmentId,
            receiptEpoch: "legacy-epoch",
            mutationId: "modern-title",
            pageId: "legacy-page",
            baseRevision: 0,
            title: "Modern",
          });
          assert.deepEqual(yield* service.createPage(old.request.input), old.receipt.result);
        }).pipe(
          Effect.provide(
            SpacesService.layerFromPath(dbPath).pipe(
              Layer.provide(
                Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
                  getEnvironmentId: Effect.succeed(environmentId),
                }),
              ),
              Layer.provide(Settings.layerTest({ spacesEnabled: true })),
            ),
          ),
        );
      }),
  );

  it.effect(
    "upgrades core content and receipts without inventing past history, and restarts with reference FKs intact",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-core-upgrade-" });
        const dbPath = path.join(directory, "spaces.sqlite");
        const before = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA application_id = 1397768515`;
          yield* Migrator.make({})({
            loader: Migrator.fromRecord({
              "1_Spaces": Migration0001.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
              "2_Core": Migration0002.pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
            }),
          }).pipe(Effect.provideService(SpacesSql.SpacesSql, sql));
          yield* sql`UPDATE spaces SET title = 'Core default', revision = 4 WHERE is_default = 1`;
          yield* sql`INSERT INTO spaces_ids VALUES ('core-page', 'page'), ('core-block', 'block')`;
          const payload = JSON.stringify({
            id: "core-block",
            parentId: null,
            order: "00000000000000000000000000000001",
            type: "future-table",
            version: 9,
            content: { text: "界" },
          });
          const blockBytes = Buffer.byteLength(payload, "utf8");
          yield* sql`INSERT INTO spaces_pages (page_id, space_id, title, revision, root_order, block_count, block_bytes, created_at, updated_at)
            VALUES ('core-page', 'default', 'Core title', 7, '00000000000000000000000000000001', 1, ${blockBytes}, '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z')`;
          yield* sql`INSERT INTO spaces_blocks (block_id, page_id, rank, payload, logical_bytes)
            VALUES ('core-block', 'core-page', '00000000000000000000000000000001', ${payload}, ${blockBytes})`;
          yield* sql`INSERT INTO spaces_epochs VALUES ('core-epoch', 99999, 999999)`;
          const environmentId = EnvironmentId.make("core-environment");
          const request = yield* decodeCoreRequest({
            operation: "renameSpace",
            input: {
              environmentId,
              mutationId: "core-mutation",
              receiptEpoch: "core-epoch",
              spaceId: "default",
              baseRevision: 3,
              title: "Core default",
            },
          });
          const [space] = yield* sql`SELECT * FROM spaces WHERE is_default = 1`;
          const receipt = yield* decodeCoreReceipt({
            operation: "renameSpace",
            result: {
              status: "saved",
              mutationId: "core-mutation",
              receiptEpoch: "core-epoch",
              space: {
                id: "default",
                title: "Core default",
                isDefault: true,
                revision: 4,
                rootOrderRevision: 0,
                createdAt: space!.created_at,
                updatedAt: space!.updated_at,
              },
            },
          });
          yield* Receipts.store(
            request,
            receipt,
            {
              environment_id: environmentId,
              observed_time_ms: 123,
              catalog_revision: 4,
              active_epoch: "core-epoch",
              receipt_rows: 0,
              receipt_bytes: 0,
            },
            999999,
          ).pipe(Effect.provideService(SpacesSql.SpacesSql, sql));
          yield* sql`UPDATE spaces_core SET environment_id = ${environmentId}, observed_time_ms = 123, catalog_revision = 4, active_epoch = 'core-epoch'`;
          return {
            core: yield* sql`SELECT * FROM spaces_core`,
            spaces: yield* sql`SELECT * FROM spaces`,
            pages: yield* sql`SELECT * FROM spaces_pages`,
            blocks: yield* sql`SELECT * FROM spaces_blocks`,
            receipts: yield* sql`SELECT * FROM spaces_receipts`,
            ids: yield* sql`SELECT * FROM spaces_ids ORDER BY id`,
          };
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        for (let open = 0; open < 2; open++)
          yield* Effect.gen(function* () {
            const sql = yield* SpacesSql.SpacesSql;
            assert.deepEqual(
              yield* sql`SELECT * FROM spaces_core`,
              before.core.map((row) => ({ ...row, revision_bytes: 0, reference_cursor: null })),
            );
            assert.deepEqual(yield* sql`SELECT * FROM spaces`, before.spaces);
            const pages = yield* sql`SELECT * FROM spaces_pages`;
            assert.deepEqual(
              pages,
              before.pages.map((page) => ({
                ...page,
                retained_revision_count: 0,
                retained_revision_bytes: 0,
                trash_batch_id: null,
                trash_root_id: null,
                trashed_at_ms: null,
                trash_origin: null,
              })),
            );
            assert.deepEqual(yield* sql`SELECT * FROM spaces_blocks`, before.blocks);
            assert.deepEqual(yield* sql`SELECT * FROM spaces_receipts`, before.receipts);
            assert.deepEqual(
              yield* sql`SELECT * FROM spaces_ids ORDER BY id`,
              before.ids.map((row) => ({ ...row, deleted: 0, merged_into: null })),
            );
            assert.deepEqual(yield* sql`SELECT * FROM spaces_revisions`, []);
            assert.equal(
              (yield* sql`SELECT revision_bytes FROM spaces_core`)[0]?.revision_bytes,
              0,
            );
            assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
            assert.equal(
              (yield* Effect.flip(
                sql`INSERT INTO spaces_block_asset_refs(block_id,asset_id) VALUES ('missing-block', 'asset')`,
              ))._tag,
              "SqlError",
            );
            assert.equal(
              (yield* Effect.flip(
                sql`INSERT INTO spaces_revision_asset_refs(page_id,to_revision,asset_id) VALUES ('core-page', 7, 'asset')`,
              ))._tag,
              "SqlError",
            );
          }).pipe(Effect.provide(Sqlite.layerFromPath(dbPath)));
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const environmentId = EnvironmentId.make("core-environment");
          const pending = yield* Effect.flip(service.search({ environmentId, query: "Core" }));
          assert.equal(pending._tag, "SpaceSearchUnavailableError");
          const found = yield* service.search({ environmentId, query: "Core" });
          assert.deepEqual(
            found.items.map((row) => row.page.id),
            [C.SpacePageId.make("core-page")],
          );
          assert.deepEqual((yield* service.search({ environmentId, query: "界" })).items, []);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepEqual(yield* sql`SELECT * FROM spaces_blocks`, before.blocks);
            assert.deepEqual(yield* sql`SELECT * FROM spaces_receipts`, before.receipts);
            assert.deepEqual(yield* sql`SELECT * FROM spaces_revisions`, []);
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        }).pipe(
          Effect.provide(
            SpacesService.layerFromPath(dbPath).pipe(
              Layer.provide(
                Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
                  getEnvironmentId: Effect.succeed(EnvironmentId.make("core-environment")),
                }),
              ),
              Layer.provide(Settings.layerTest({ spacesEnabled: true })),
            ),
          ),
        );
      }),
  );

  it.effect.each(["missing", "empty"] as const)(
    "preserves spaces and the renamed default across a full close and reopen from a %s file",
    (initial) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-restart-" });
        const dbPath = path.join(directory, "nested", "spaces.sqlite");
        if (initial === "empty") {
          yield* fs.makeDirectory(path.dirname(dbPath));
          yield* fs.writeFileString(dbPath, "");
        }
        const persistence = Sqlite.layerFromPath(dbPath);
        const originalId = yield* Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          const [space] = yield* sql<{ readonly space_id: string }>`
          SELECT space_id FROM spaces WHERE is_default = 1
        `;
          assert.isDefined(space);
          yield* sql`UPDATE spaces SET title = 'Renamed', revision = 1 WHERE is_default = 1`;
          yield* sql`
          INSERT INTO spaces (space_id, title, is_default, created_at, updated_at)
          VALUES ('second', 'Second', 0, '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z')
        `;
          assert.equal((yield* sql`PRAGMA journal_mode`)[0]?.journal_mode, "wal");
          assert.equal((yield* sql`PRAGMA auto_vacuum`)[0]?.auto_vacuum, 2);
          assert.equal((yield* sql`PRAGMA foreign_keys`)[0]?.foreign_keys, 1);
          return space?.space_id;
        }).pipe(Effect.provide(persistence));

        yield* Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          assert.deepEqual(
            yield* sql`SELECT space_id, title, revision FROM spaces WHERE is_default = 1`,
            [{ space_id: originalId, title: "Renamed", revision: 1 }],
          );
          assert.equal((yield* sql`SELECT COUNT(*) AS count FROM spaces`)[0]?.count, 2);
          assert.equal(
            (yield* sql`SELECT COUNT(*) AS count FROM effect_sql_migrations`)[0]?.count,
            10,
          );
          assert.equal(
            (yield* Effect.flip(sql`DELETE FROM spaces WHERE is_default = 1`))._tag,
            "SqlError",
          );
          assert.equal(
            (yield* Effect.flip(sql`UPDATE spaces SET is_default = 1 WHERE space_id = 'second'`))
              ._tag,
            "SqlError",
          );
          assert.equal((yield* sql`SELECT COUNT(*) AS count FROM spaces`)[0]?.count, 2);
        }).pipe(Effect.provide(persistence));
      }),
  );

  it.effect("refuses a chat database with outstanding WAL without checkpointing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-foreign-chat-" });
      const dbPath = path.join(directory, "statev2.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE keep_chat (value TEXT)`;
        yield* sql`INSERT INTO keep_chat VALUES ('retained')`;
      }).pipe(Effect.provide(ChatSqlite.layerFromPath(dbPath)));
      const writer = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import { DatabaseSync } from 'node:sqlite';
            const db = new DatabaseSync(process.argv[1]);
            db.exec("PRAGMA wal_autocheckpoint = 0; INSERT INTO keep_chat VALUES ('outstanding WAL')");
            process.exit(0);
          `,
          dbPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(writer.status, 0, writer.stderr);
      const before = yield* fs.readFile(dbPath);
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      const beforeWal = yield* fs.readFile(walPath);
      assert.isAbove(beforeWal.length, 32);
      assert.isTrue(yield* fs.exists(shmPath));
      const failure = yield* SpacesSql.SpacesSql.pipe(
        Effect.provide(Sqlite.layerFromPath(dbPath)),
        Effect.flip,
      );
      assert.equal(failure._tag, "SpacesDatabaseMismatchError");
      assert.equal(
        Buffer.compare(yield* fs.readFile(dbPath), before),
        0,
        "Foreign main DB changed",
      );
      assert.isTrue(yield* fs.exists(walPath), "Foreign WAL was removed");
      assert.equal(
        Buffer.compare(yield* fs.readFile(walPath), beforeWal),
        0,
        "Foreign WAL changed",
      );
      assert.isTrue(yield* fs.exists(shmPath), "Foreign shared memory was removed");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT value FROM keep_chat ORDER BY rowid`, [
          { value: "retained" },
          { value: "outstanding WAL" },
        ]);
        assert.equal(
          (yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 1`)[0]?.name,
          "OrchestrationEvents",
        );
        assert.deepEqual(yield* sql`SELECT name FROM sqlite_schema WHERE name = 'spaces'`, []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
    }),
  );

  it.effect.each([
    "foreign",
    "foreign-prefix",
    "foreign-view",
    "renamed",
    "newer",
    "missing",
  ] as const)("refuses %s database history without repairing or overwriting it", (kind) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-history-" });
      const dbPath = path.join(directory, "spaces.sqlite");
      if (kind === "renamed" || kind === "newer" || kind === "missing") {
        yield* SpacesSql.SpacesSql.pipe(Effect.provide(Sqlite.layerFromPath(dbPath)));
      }
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        switch (kind) {
          case "foreign":
            yield* sql`CREATE TABLE keep_data (value TEXT)`;
            yield* sql`INSERT INTO keep_data VALUES ('retained')`;
            break;
          case "foreign-prefix":
            yield* sql`CREATE TABLE sqliteXforeign (value TEXT)`;
            break;
          case "foreign-view":
            yield* sql`CREATE VIEW keep_view AS SELECT 'retained' AS value`;
            break;
          case "renamed":
            yield* sql`UPDATE effect_sql_migrations SET name = 'Unrelated' WHERE migration_id = 1`;
            break;
          case "newer":
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (11, 'NewerSpaces')`;
            break;
          case "missing":
            yield* sql`DROP TABLE effect_sql_migrations`;
            break;
        }
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
      const before = yield* fs.readFile(dbPath);
      const failure = yield* SpacesSql.SpacesSql.pipe(
        Effect.provide(Sqlite.layerFromPath(dbPath)),
        Effect.flip,
      );
      assert.equal(failure._tag, "SpacesDatabaseMismatchError");
      assert.deepEqual(yield* fs.readFile(dbPath), before);
    }),
  );
});
