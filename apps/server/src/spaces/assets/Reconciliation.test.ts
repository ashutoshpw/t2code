import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as Config from "../../config.ts";
import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as Identity from "../../environment/ServerEnvironment.ts";
import * as Settings from "../../serverSettings.ts";
import * as Service from "../SpacesService.ts";

const environmentId = EnvironmentId.make("media-refs");
const env = { environmentId };
const pdf = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const fixture = Effect.fn("SpacesReconciliationTest.fixture")(function* <A, E, R>(
  use: (input: {
    readonly config: Config.ServerConfig["Service"];
    readonly live: () => ReturnType<typeof Service.layerFromPath>;
  }) => Effect.Effect<A, E, R>,
) {
  const context = yield* Layer.buildWithScope(
    Config.ServerConfig.layerTest(process.cwd(), { prefix: "spaces-media-" }),
    yield* Effect.scope,
  );
  const config = Context.get(context, Config.ServerConfig);
  const live = () =>
    Service.layerFromPath(config.spacesDbPath, {
      assetsDir: config.spacesAssetsDir,
      stagingDir: config.spacesStagingDir,
    });
  return yield* use({ config, live }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Secrets.layer.pipe(Layer.provide(Layer.succeedContext(context))),
        Settings.layerTest({ spacesEnabled: true }),
        Layer.succeed(Identity.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
    ),
  );
}, Effect.provide(NodeServices.layer));

const upload = Effect.fn("SpacesReconciliationTest.upload")(function* (requestId: string) {
  const service = yield* Service.SpacesService;
  const reservation = yield* service.createAssetUpload(
    {
      ...env,
      requestId,
      expectedBytes: pdf.length,
      mediaKind: "pdf",
      mimeType: "application/pdf",
      name: "paper.pdf",
    },
    "owner",
  );
  yield* service.receiveAssetUpload(
    reservation.relativeUrl.slice(reservation.relativeUrl.lastIndexOf("/") + 1),
    String(pdf.length),
    Stream.make(pdf),
  );
  return yield* service.finalizeAssetUpload({ ...env, uploadId: reservation.uploadId }, "owner");
});
const media = (id: string, assetId: C.SpaceAssetId, text = id): C.SpaceBlock => ({
  id: C.SpaceBlockId.make(id),
  parentId: null,
  order: id.padStart(32, "0"),
  type: "pdf",
  version: 1,
  content: { assetId, caption: [{ text, marks: [] }] },
});
const text = (id: string, value = id): C.SpaceBlock => ({
  id: C.SpaceBlockId.make(id),
  parentId: null,
  order: id.padStart(32, "0"),
  type: "paragraph",
  version: 1,
  content: { runs: [{ text: value, marks: [] }] },
});
const boot = Effect.fn("SpacesReconciliationTest.boot")(function* () {
  const service = yield* Service.SpacesService;
  const library = yield* service.listSpaces(env);
  const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
  const result = yield* service.createPage({
    ...common,
    mutationId: "page",
    spaceId: library.defaultSpaceId,
    baseRootOrderRevision: 0,
    title: "Media",
  });
  if (result.status !== "saved") return yield* Effect.die("Expected page");
  const pageId = result.page.id;
  const request = (
    mutationId: string,
    baseRevision: number,
    mutations: readonly C.SpaceBlockMutation[],
  ) => ({
    ...common,
    mutationId,
    pageId,
    baseRevision,
    generation: baseRevision,
    mutations,
  });
  return { service, pageId, request };
});
const inspect = Effect.fn("SpacesReconciliationTest.inspect")(function* (
  config: Config.ServerConfig["Service"],
) {
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      core: yield* sql`SELECT * FROM spaces_core`,
      pages: yield* sql`SELECT * FROM spaces_pages ORDER BY page_id`,
      blocks: yield* sql`SELECT * FROM spaces_blocks ORDER BY block_id`,
      ids: yield* sql`SELECT * FROM spaces_ids ORDER BY id`,
      receipts: yield* sql`SELECT * FROM spaces_receipts ORDER BY mutation_id`,
      revisions: yield* sql<{
        readonly to_revision: number;
        readonly mutation_id: string;
        readonly payload: string;
        readonly asset_count: number;
        readonly logical_bytes: number;
      }>`SELECT * FROM spaces_revisions ORDER BY page_id,to_revision`,
      current: yield* sql<{
        readonly block_id: string;
        readonly asset_id: string;
      }>`SELECT * FROM spaces_block_asset_refs ORDER BY block_id`,
      history: yield* sql<{
        readonly to_revision: number;
        readonly asset_id: string;
      }>`SELECT * FROM spaces_revision_asset_refs ORDER BY page_id,to_revision,asset_id`,
      usage: yield* sql`SELECT * FROM spaces_asset_usage`,
    };
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath, readonly: true })),
  );
});

const progress = Effect.fn("SpacesReconciliationTest.progress")(function* (
  config: Config.ServerConfig["Service"],
) {
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      state: (yield* sql<{
        readonly block_cursor: string;
        readonly blocks_done: number;
        readonly history_revision: number;
        readonly history_done: number;
        readonly assets_bytes: number;
        readonly staging_bytes: number;
      }>`SELECT * FROM spaces_asset_reconciliation`)[0]!,
      issues: yield* sql<{
        readonly kind: string;
        readonly entity: string;
        readonly reason: string;
      }>`SELECT * FROM spaces_asset_reconciliation_issues ORDER BY kind,entity`,
    };
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath, readonly: true })),
  );
});

it.effect(
  "persists bounded current-reference progress and retains concurrent writes behind its cursor",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const first = yield* Effect.gen(function* () {
          const { service, request, pageId } = yield* boot();
          const asset = yield* upload("legacy");
          const blocks = Array.from({ length: 51 }, (_, i) =>
            media((i + 16).toString(16).padStart(3, "0"), asset.assetId),
          );
          yield* service.applyBlockBatch(
            request(
              "initial",
              0,
              blocks.map((block) => ({ kind: "insert", block })),
            ),
          );
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DELETE FROM spaces_block_asset_refs`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
          expect(
            (yield* service.getCapability(environmentId))?.assetReconciliation?.currentPending,
          ).toBe(true);
          const report = yield* service.maintainAssets;
          expect(report?.reconciliation.gcEnabled).toBe(false);
          expect((yield* inspect(config)).current).toHaveLength(25);
          const cursor = (yield* progress(config)).state.block_cursor;
          yield* service.applyBlockBatch(
            request("behind", 1, [{ kind: "insert", block: media("001", asset.assetId) }]),
          );
          return { pageId, cursor };
        }).pipe(Effect.provide(live()));
        yield* Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          yield* service.getPage({ ...env, pageId: first.pageId });
          expect((yield* progress(config)).state.block_cursor).toBe(first.cursor);
          yield* service.maintainAssets;
          expect((yield* inspect(config)).current).toHaveLength(51);
          yield* service.maintainAssets;
          expect((yield* inspect(config)).current).toHaveLength(52);
          expect((yield* progress(config)).state.blocks_done).toBe(1);
          const unknown = { ...text("000"), future: { assetId: "unknown" } };
          const library = yield* service.listSpaces(env);
          yield* service.applyBlockBatch({
            ...env,
            receiptEpoch: library.mutationAdmission.epoch,
            mutationId: "opaque-behind",
            pageId: first.pageId,
            baseRevision: 2,
            generation: 2,
            mutations: [{ kind: "insert", block: unknown }],
          });
          expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
            currentPending: false,
            unresolved: true,
            gcEnabled: false,
          });
          expect(
            (yield* service.readBlocks({ ...env, pageId: first.pageId, revision: 3 })).blocks.find(
              (block) => block.id === "000",
            ),
          ).toEqual(unknown);
        }).pipe(Effect.provide(live()));
      }),
    ),
);

it.effect(
  "repairs old history pins and exact byte counters atomically, retrying a real SQL refusal",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const { service, request } = yield* boot();
        const a = yield* upload("a"),
          b = yield* upload("b");
        yield* service.applyBlockBatch(
          request("initial", 0, [{ kind: "insert", block: media("a", a.assetId) }]),
        );
        yield* service.applyBlockBatch(
          request("replace", 1, [{ kind: "replace", block: media("a", b.assetId) }]),
        );
        const original = yield* inspect(config);
        const row = original.revisions.find((row) => row.to_revision === 2)!;
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [record] = yield* sql<{
            readonly page_id: string;
            readonly mutation_id: string;
            readonly created_at_ms: number;
            readonly expires_at_ms: number;
            readonly payload: string;
          }>`SELECT * FROM spaces_revisions WHERE to_revision=2`;
          const bytes = Buffer.byteLength(
            JSON.stringify({
              pageId: record!.page_id,
              toRevision: 2,
              mutationId: record!.mutation_id,
              createdAtMs: record!.created_at_ms,
              expiresAtMs: record!.expires_at_ms,
              payload: record!.payload,
              assetIds: [],
            }),
          );
          const delta = row.logical_bytes - bytes;
          yield* sql`DELETE FROM spaces_revision_asset_refs WHERE to_revision=2`;
          yield* sql`UPDATE spaces_revisions SET logical_bytes=${bytes},asset_count=0 WHERE to_revision=2`;
          yield* sql`UPDATE spaces_pages SET retained_revision_bytes=retained_revision_bytes-${delta}`;
          yield* sql`UPDATE spaces_core SET revision_bytes=revision_bytes-${delta}`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        for (const _step of [0, 1, 2]) yield* service.maintainAssets;
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER refuse_repair BEFORE UPDATE OF revision_bytes ON spaces_core WHEN NEW.revision_bytes <> OLD.revision_bytes BEGIN SELECT RAISE(ABORT,'repair interrupted'); END`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        const damaged = yield* inspect(config),
          beforeProgress = yield* progress(config);
        expect(yield* service.maintainAssets.pipe(Effect.flip)).toMatchObject({
          _tag: "SpacesUnavailableError",
        });
        expect(yield* inspect(config)).toEqual(damaged);
        expect(yield* progress(config)).toEqual(beforeProgress);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TRIGGER refuse_repair`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        yield* service.maintainAssets;
        const repaired = yield* inspect(config);
        expect(repaired.history).toEqual(original.history);
        expect(repaired.revisions).toEqual(original.revisions);
        expect(repaired.pages).toEqual(original.pages);
        expect(repaired.core).toEqual(original.core);
        expect((yield* service.getCapability(environmentId))?.assetReconciliation?.gcEnabled).toBe(
          false,
        );
      }).pipe(Effect.provide(live())),
    ),
);

it.effect(
  "refuses an indivisible hundred-pin legacy repair and unknown preimage versions without truncation",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const { service, request } = yield* boot();
        const asset = yield* upload("a");
        yield* service.applyBlockBatch(
          request("initial", 0, [{ kind: "insert", block: media("a", asset.assetId) }]),
        );
        yield* service.applyBlockBatch(
          request("delete", 1, [{ kind: "delete", blockId: C.SpaceBlockId.make("a") }]),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<{
            readonly page_id: string;
            readonly mutation_id: string;
            readonly created_at_ms: number;
            readonly expires_at_ms: number;
            readonly payload: string;
            readonly logical_bytes: number;
          }>`SELECT * FROM spaces_revisions WHERE to_revision=2`;
          const ids = Array.from(
            { length: 99 },
            (_, i) => `legacy-${i.toString().padStart(3, "0")}`,
          );
          const size = Buffer.byteLength(
            JSON.stringify({
              pageId: row!.page_id,
              toRevision: 2,
              mutationId: row!.mutation_id,
              createdAtMs: row!.created_at_ms,
              expiresAtMs: row!.expires_at_ms,
              payload: row!.payload,
              assetIds: ids,
            }),
          );
          yield* sql`DELETE FROM spaces_revision_asset_refs WHERE to_revision=2`;
          for (const id of ids)
            yield* sql`INSERT INTO spaces_revision_asset_refs(page_id,to_revision,asset_id) VALUES (${row!.page_id},2,${id})`;
          yield* sql`UPDATE spaces_revisions SET logical_bytes=${size},asset_count=99 WHERE to_revision=2`;
          yield* sql`UPDATE spaces_pages SET retained_revision_bytes=retained_revision_bytes+${size - row!.logical_bytes}`;
          yield* sql`UPDATE spaces_core SET revision_bytes=revision_bytes+${size - row!.logical_bytes}`;
          const [future] = yield* sql<{
            readonly page_id: string;
            readonly mutation_id: string;
            readonly created_at_ms: number;
            readonly expires_at_ms: number;
            readonly logical_bytes: number;
          }>`SELECT * FROM spaces_revisions WHERE to_revision=0`;
          const payload = '{"version":999}';
          const futureSize = Buffer.byteLength(
            JSON.stringify({
              pageId: future!.page_id,
              toRevision: 0,
              mutationId: future!.mutation_id,
              createdAtMs: future!.created_at_ms,
              expiresAtMs: future!.expires_at_ms,
              payload,
              assetIds: [],
            }),
          );
          yield* sql`UPDATE spaces_revisions SET payload=${payload},logical_bytes=${futureSize} WHERE to_revision=0`;
          yield* sql`UPDATE spaces_pages SET retained_revision_bytes=retained_revision_bytes+${futureSize - future!.logical_bytes}`;
          yield* sql`UPDATE spaces_core SET revision_bytes=revision_bytes+${futureSize - future!.logical_bytes}`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        const before = yield* inspect(config);
        for (const _step of [0, 1, 2, 3, 4]) yield* service.maintainAssets;
        expect(yield* inspect(config)).toEqual(before);
        expect((yield* progress(config)).issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "history", reason: "capacity" }),
            expect.objectContaining({ kind: "history", reason: "unknown_payload" }),
          ]),
        );
        expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
          historyPending: false,
          unresolved: true,
          gcEnabled: false,
        });
      }).pipe(Effect.provide(live())),
    ),
);

it.effect(
  "streams bounded unknown-staging discovery across restarts and retains old files beyond grace",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(config.spacesStagingDir, { recursive: true });
        for (let i = 0; i < 24; i++) {
          yield* fs.writeFileString(path.join(config.spacesStagingDir, `${i}.part`), "0123456789");
          yield* fs.utimes(path.join(config.spacesStagingDir, `${i}.part`), 0, 0);
        }
        yield* Effect.gen(function* () {
          const { service } = yield* boot();
          for (const _step of [0, 1, 2, 3]) yield* service.maintainAssets;
          const first = yield* service.maintainAssets;
          expect(first?.observedStagingFileBytes).toBe(100);
          expect(first?.reconciliation).toMatchObject({
            inventoryPending: true,
            unresolved: true,
            gcEnabled: false,
          });
        }).pipe(Effect.provide(live()));
        yield* Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          const restarted = yield* service.maintainAssets;
          expect(restarted?.observedStagingFileBytes).toBe(100);
          yield* service.maintainAssets;
          const complete = yield* service.maintainAssets;
          expect(complete?.observedStagingFileBytes).toBe(240);
          expect(complete?.reconciliation).toMatchObject({
            inventoryPending: false,
            unresolved: true,
            gcEnabled: false,
          });
          expect(yield* fs.readDirectory(config.spacesStagingDir)).toHaveLength(24);
          yield* TestClock.adjust("25 hours");
          for (const _step of [0, 1, 2, 3, 4, 5, 6]) yield* service.maintainAssets;
          expect((yield* progress(config)).issues).toEqual(
            expect.arrayContaining([expect.objectContaining({ reason: "unknown_after_grace" })]),
          );
          expect(yield* fs.readDirectory(config.spacesStagingDir)).toHaveLength(24);
          expect(
            (yield* service.getCapability(environmentId))?.assetReconciliation?.gcEnabled,
          ).toBe(false);
        }).pipe(Effect.provide(live()));
      }),
    ),
);

it.effect(
  "accounts real staging retained by failed cleanup and releases it only after observed absence",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { service } = yield* boot();
        const minted = yield* service.createAssetUpload(
          {
            ...env,
            requestId: "retained",
            expectedBytes: pdf.length,
            mimeType: "application/pdf",
            mediaKind: "pdf",
            name: "retained.pdf",
          },
          "owner",
        );
        yield* fs.makeDirectory(config.spacesStagingDir, { recursive: true });
        yield* fs.writeFileString(config.spacesAssetsDir, "prevents publication");
        const body = Stream.make(pdf).pipe(
          Stream.concat(
            Stream.fromEffect(
              fs.chmod(config.spacesStagingDir, 0o500).pipe(Effect.as(new Uint8Array())),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          expect(
            yield* service
              .receiveAssetUpload(
                minted.relativeUrl.slice(minted.relativeUrl.lastIndexOf("/") + 1),
                String(pdf.length),
                body,
              )
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "publication_failed" });
          yield* fs.remove(config.spacesAssetsDir);
          for (const _step of [0, 1, 2, 3, 4]) yield* service.maintainAssets;
          const report = yield* service.maintainAssets;
          expect(report?.reservedBytes).toBe(pdf.length);
          expect(report?.observedStagingFileBytes).toBe(pdf.length);
          yield* fs.chmod(config.spacesStagingDir, 0o700);
          const ready = yield* service.finalizeAssetUpload(
            { ...env, uploadId: minted.uploadId },
            "owner",
          );
          expect(yield* service.getAssetMetadata({ ...env, assetId: ready.assetId })).toEqual(
            ready,
          );
          const cleaned = yield* service.maintainAssets;
          expect(cleaned?.reservedBytes).toBe(0);
          expect(cleaned?.registeredAssetBytes).toBe(pdf.length);
          expect((yield* service.maintainAssets)?.observedStagingFileBytes).toBe(0);
        }).pipe(Effect.ensuring(fs.chmod(config.spacesStagingDir, 0o700).pipe(Effect.orDie)));
      }).pipe(Effect.provide(live())),
    ),
);

it.effect("detects same-size corruption without freeing bytes or claiming catalog readiness", () =>
  fixture(({ config, live }) =>
    Effect.gen(function* () {
      const { service, request } = yield* boot();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const asset = yield* upload("corruption");
      yield* service.applyBlockBatch(
        request("insert", 0, [{ kind: "insert", block: media("a", asset.assetId) }]),
      );
      yield* fs.writeFile(
        path.join(config.spacesAssetsDir, asset.digest),
        new Uint8Array(pdf.length).fill(42),
      );
      for (const _step of [0, 1, 2, 3, 4]) yield* service.maintainAssets;
      expect((yield* progress(config)).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "blob", reason: "unavailable_file" }),
        ]),
      );
      expect(
        yield* service.getAssetMetadata({ ...env, assetId: asset.assetId }).pipe(Effect.flip),
      ).toMatchObject({ reason: "not_found" });
      const report = yield* service.maintainAssets;
      expect(report?.registeredAssetBytes).toBe(pdf.length);
      expect(report?.reconciliation).toMatchObject({ unresolved: true, gcEnabled: false });
      expect((yield* inspect(config)).current).toEqual([
        { block_id: "a", asset_id: asset.assetId },
      ]);
    }).pipe(Effect.provide(live())),
  ),
);

it.effect("keeps maintenance disabled and noncreating until Spaces is enabled", () =>
  fixture(({ config, live }) =>
    Effect.gen(function* () {
      const service = yield* Service.SpacesService;
      const settings = yield* Settings.ServerSettingsService;
      const fs = yield* FileSystem.FileSystem;
      yield* settings.updateSettings({ spacesEnabled: false });
      expect(yield* service.maintainAssets).toBeNull();
      expect(yield* fs.exists(config.spacesDbPath)).toBe(false);
      yield* settings.updateSettings({ spacesEnabled: true });
      expect((yield* service.maintainAssets)?.reconciliation.gcEnabled).toBe(false);
      expect(yield* fs.exists(config.spacesDbPath)).toBe(true);
      for (const _step of [0, 1, 2]) yield* service.maintainAssets;
      expect((yield* service.getCapability(environmentId))?.assetReconciliation).toEqual({
        currentPending: false,
        historyPending: false,
        catalogPending: false,
        inventoryPending: false,
        unresolved: false,
        gcEnabled: false,
      });
    }).pipe(Effect.provide(live())),
  ),
);

it.effect(
  "retries inventory completion when a real new claim races an existing directory sweep",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const { service } = yield* boot();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(config.spacesStagingDir, { recursive: true });
        for (let i = 0; i < 24; i++)
          yield* fs.writeFileString(path.join(config.spacesStagingDir, `${i}.part`), "x");
        for (const _step of [0, 1, 2, 3]) yield* service.maintainAssets;
        const start = Effect.fn("SpacesReconciliationTest.startClaim")(function* (id: string) {
          const reservation = yield* service.createAssetUpload(
            {
              ...env,
              requestId: id,
              expectedBytes: pdf.length,
              mimeType: "application/pdf",
              mediaKind: "pdf",
              name: "live.pdf",
            },
            "owner",
          );
          const entered = yield* Deferred.make<void>();
          const body = Stream.make(pdf.subarray(0, 8)).pipe(
            Stream.concat(
              Stream.fromEffect(
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
              ),
            ),
          );
          const fiber = yield* service
            .receiveAssetUpload(
              reservation.relativeUrl.slice(reservation.relativeUrl.lastIndexOf("/") + 1),
              String(pdf.length),
              body,
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          return fiber;
        });
        const first = yield* start("first");
        yield* service.maintainAssets;
        const second = yield* start("second");
        yield* service.maintainAssets;
        const ended = yield* service.maintainAssets;
        expect(ended?.reconciliation.inventoryPending).toBe(true);
        expect((yield* service.getCapability(environmentId))?.assetRecoveryPending).toBe(false);
        yield* Fiber.interrupt(first);
        yield* Fiber.interrupt(second);
        for (const _step of [0, 1, 2]) yield* service.maintainAssets;
        expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
          inventoryPending: false,
          unresolved: true,
          gcEnabled: false,
        });
      }).pipe(Effect.provide(live())),
    ),
);
