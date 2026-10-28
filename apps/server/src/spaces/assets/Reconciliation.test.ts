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

const upload = Effect.fn("SpacesReconciliationTest.upload")(function* (
  requestId: string,
  data = pdf,
) {
  const service = yield* Service.SpacesService;
  const reservation = yield* service.createAssetUpload(
    {
      ...env,
      requestId,
      expectedBytes: data.length,
      mediaKind: "pdf",
      mimeType: "application/pdf",
      name: "paper.pdf",
    },
    "owner",
  );
  yield* service.receiveAssetUpload(
    reservation.relativeUrl.slice(reservation.relativeUrl.lastIndexOf("/") + 1),
    String(data.length),
    Stream.make(data),
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
      }>`SELECT block_id,asset_id FROM spaces_block_asset_refs ORDER BY block_id`,
      history: yield* sql<{
        readonly to_revision: number;
        readonly asset_id: string;
      }>`SELECT page_id,to_revision,asset_id FROM spaces_revision_asset_refs ORDER BY page_id,to_revision,asset_id`,
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
        readonly format_version: number;
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

it.effect.each([
  "complete",
  "source_failure",
  "cancel_before_creation",
  "cancel_after_creation",
] as const)(
  "keeps staging inventory pending across claimed-but-uncreated files and %s",
  (outcome) =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directoryEntered = yield* Deferred.make<void>();
        const releaseDirectory = yield* Deferred.make<void>();
        const streaming = yield* Deferred.make<void>();
        const finishBody = yield* Deferred.make<void, string>();
        let holdDirectory = false;
        const gatedFs = {
          ...fs,
          makeDirectory: (target: string, options?: Parameters<typeof fs.makeDirectory>[1]) =>
            target === config.spacesStagingDir && holdDirectory
              ? Deferred.succeed(directoryEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseDirectory)),
                  Effect.andThen(fs.makeDirectory(target, options)),
                )
              : fs.makeDirectory(target, options),
        };
        yield* Effect.gen(function* () {
          const { service, pageId } = yield* boot();
          for (const _step of [0, 1, 2, 3]) yield* service.maintainAssets;
          const reservation = yield* service.createAssetUpload(
            {
              ...env,
              requestId: "held",
              expectedBytes: pdf.length,
              mimeType: "application/pdf",
              mediaKind: "pdf",
              name: "held.pdf",
            },
            "owner",
          );
          holdDirectory = true;
          const body = Stream.make(pdf.subarray(0, 8)).pipe(
            Stream.concat(
              Stream.fromEffect(
                Deferred.succeed(streaming, undefined).pipe(
                  Effect.andThen(Deferred.await(finishBody)),
                  Effect.as(pdf.subarray(8)),
                ),
              ),
            ),
          );
          const receiver = yield* service
            .receiveAssetUpload(
              reservation.relativeUrl.slice(reservation.relativeUrl.lastIndexOf("/") + 1),
              String(pdf.length),
              body,
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(directoryEntered);
          const beforeCreation = yield* service.maintainAssets;
          expect(beforeCreation?.reservedBytes).toBe(pdf.length);
          expect(
            yield* service.getAssetUpload({ ...env, uploadId: reservation.uploadId }, "owner"),
          ).toMatchObject({ state: "receiving", recoveryPending: false });
          expect(
            yield* service
              .finalizeAssetUpload({ ...env, uploadId: reservation.uploadId }, "owner")
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "already_claimed" });
          const page = yield* service.getPage({ ...env, pageId });
          expect(
            (yield* service.updatePage({
              ...env,
              receiptEpoch: page.mutationAdmission.epoch,
              mutationId: "independent-writer",
              pageId,
              baseRevision: page.page.revision,
              title: "Writer during held creation",
            })).status,
          ).toBe("saved");
          if (outcome === "cancel_before_creation") {
            expect(beforeCreation?.reconciliation.inventoryPending).toBe(true);
            yield* Fiber.interrupt(receiver);
            expect(yield* fs.exists(config.spacesStagingDir)).toBe(false);
          } else {
            yield* Deferred.succeed(releaseDirectory, undefined);
            yield* Deferred.await(streaming);
            const files = yield* fs.readDirectory(config.spacesStagingDir);
            expect(files).toHaveLength(1);
            expect(
              Number((yield* fs.stat(path.join(config.spacesStagingDir, files[0]!))).size),
            ).toBe(8);
            const duringStreaming = yield* service.maintainAssets;
            expect(duringStreaming?.observedStagingFileBytes).toBe(8);
            expect(beforeCreation?.reconciliation.inventoryPending).toBe(true);
            expect(duringStreaming?.reconciliation.inventoryPending).toBe(true);
            expect((yield* service.getCapability(environmentId))?.assetRecoveryPending).toBe(false);
            if (outcome === "cancel_after_creation") yield* Fiber.interrupt(receiver);
            else if (outcome === "source_failure") {
              yield* Deferred.fail(finishBody, "source failed");
              expect(yield* Fiber.join(receiver).pipe(Effect.flip)).toMatchObject({
                reason: "source_failed",
              });
            } else {
              yield* Deferred.succeed(finishBody, undefined);
              yield* Fiber.join(receiver);
            }
            expect(yield* fs.readDirectory(config.spacesStagingDir)).toEqual([]);
          }
          expect(
            yield* service.getAssetUpload({ ...env, uploadId: reservation.uploadId }, "owner"),
          ).toMatchObject({
            state: outcome === "complete" ? "ready" : "reserved",
            recoveryPending: false,
          });
          for (const _step of [0, 1]) yield* service.maintainAssets;
          const settled = yield* service.maintainAssets;
          expect(settled?.observedStagingFileBytes).toBe(0);
          expect(settled?.reconciliation).toMatchObject({
            inventoryPending: false,
            unresolved: false,
            gcEnabled: true,
          });
          expect((yield* inspect(config)).usage[0]?.active_count).toBe(0);
        }).pipe(
          Effect.provide(live().pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, gatedFs)))),
        );
      }),
    ),
);

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
        gcEnabled: true,
        gcPending: true,
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

it.effect("invalidates an open staging sweep after actual staging becomes verified", () =>
  fixture(({ config, live }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const creationEntered = yield* Deferred.make<void>();
      const releaseCreation = yield* Deferred.make<void>();
      const publicationEntered = yield* Deferred.make<void>();
      const releasePublication = yield* Deferred.make<void>();
      const gatedFs = {
        ...fs,
        makeDirectory: (target: string, options?: Parameters<typeof fs.makeDirectory>[1]) => {
          const operation = fs.makeDirectory(target, options);
          return target === config.spacesStagingDir
            ? Deferred.succeed(creationEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCreation)),
                Effect.andThen(operation),
              )
            : target === config.spacesAssetsDir
              ? Deferred.succeed(publicationEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releasePublication)),
                  Effect.andThen(operation),
                )
              : operation;
        },
      };
      yield* fs.makeDirectory(config.spacesStagingDir, { recursive: true });
      for (let i = 0; i < 24; i++)
        yield* fs.writeFileString(path.join(config.spacesStagingDir, `old-${i}.part`), "x");
      yield* Effect.gen(function* () {
        const { service } = yield* boot();
        for (const _step of [0, 1, 2, 3]) yield* service.maintainAssets;
        const reservation = yield* service.createAssetUpload(
          {
            ...env,
            requestId: "verified-during-sweep",
            expectedBytes: pdf.length,
            mimeType: "application/pdf",
            mediaKind: "pdf",
            name: "verified.pdf",
          },
          "owner",
        );
        const receiver = yield* service
          .receiveAssetUpload(
            reservation.relativeUrl.slice(reservation.relativeUrl.lastIndexOf("/") + 1),
            String(pdf.length),
            Stream.make(pdf),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(creationEntered);
        yield* service.maintainAssets;
        yield* Deferred.succeed(releaseCreation, undefined);
        yield* Deferred.await(publicationEntered);
        expect(
          yield* service.getAssetUpload({ ...env, uploadId: reservation.uploadId }, "owner"),
        ).toMatchObject({ state: "verified", recoveryPending: false });
        yield* service.maintainAssets;
        expect((yield* service.maintainAssets)?.reconciliation.inventoryPending).toBe(true);
        yield* Deferred.succeed(releasePublication, undefined);
        const asset = yield* Fiber.join(receiver);
        expect(yield* service.getAssetMetadata({ ...env, assetId: asset.assetId })).toEqual(asset);
        for (const _step of [0, 1, 2]) yield* service.maintainAssets;
        expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
          inventoryPending: false,
          unresolved: true,
          gcEnabled: false,
        });
      }).pipe(
        Effect.provide(live().pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, gatedFs)))),
      );
    }),
  ),
);

it.effect(
  "reopens an older completed reconciliation format and discovers future history behind its cursor",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const first = yield* Effect.gen(function* () {
          const { service, pageId, request } = yield* boot();
          const asset = yield* upload("format-a");
          yield* service.applyBlockBatch(
            request("format-insert", 0, [{ kind: "insert", block: media("a", asset.assetId) }]),
          );
          yield* service.applyBlockBatch(
            request("format-delete", 1, [{ kind: "delete", blockId: C.SpaceBlockId.make("a") }]),
          );
          for (const _pass of [0, 1, 2, 3, 4, 5]) yield* service.maintainAssets;
          expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
            currentPending: false,
            historyPending: false,
            unresolved: false,
          });
          return { pageId, asset };
        }).pipe(Effect.provide(live()), Effect.scoped);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<{
            readonly mutation_id: string;
            readonly created_at_ms: number;
            readonly expires_at_ms: number;
            readonly payload: string;
            readonly logical_bytes: number;
          }>`SELECT * FROM spaces_revisions WHERE page_id=${first.pageId} AND to_revision=2`;
          const payload = JSON.stringify({ ...JSON.parse(row!.payload), version: 999 });
          const logicalBytes = Buffer.byteLength(
            JSON.stringify({
              pageId: first.pageId,
              toRevision: 2,
              mutationId: row!.mutation_id,
              createdAtMs: row!.created_at_ms,
              expiresAtMs: row!.expires_at_ms,
              payload,
              assetIds: [first.asset.assetId],
            }),
          );
          const delta = logicalBytes - row!.logical_bytes;
          yield* sql`UPDATE spaces_revisions SET payload=${payload},logical_bytes=${logicalBytes} WHERE page_id=${first.pageId} AND to_revision=2`;
          yield* sql`UPDATE spaces_pages SET retained_revision_bytes=retained_revision_bytes+${delta} WHERE page_id=${first.pageId}`;
          yield* sql`UPDATE spaces_core SET revision_bytes=revision_bytes+${delta}`;
          yield* sql`UPDATE spaces_asset_reconciliation SET format_version=2,block_cursor='zzzz',blocks_done=1,history_page='zzzz',history_revision=999,history_done=1`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        yield* Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
            currentPending: true,
            historyPending: true,
            gcEnabled: false,
          });
          expect((yield* progress(config)).state).toMatchObject({
            format_version: 4,
            block_cursor: "",
            history_revision: -1,
          });
          const before = yield* inspect(config);
          for (const _pass of [0, 1, 2, 3, 4]) yield* service.maintainAssets;
          expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
            currentPending: false,
            historyPending: false,
            unresolved: true,
            gcEnabled: false,
          });
          expect((yield* progress(config)).issues).toEqual([
            {
              kind: "history",
              entity: JSON.stringify([first.pageId, 2]),
              reason: "unknown_payload",
            },
          ]);
          expect((yield* inspect(config)).history).toEqual(before.history);
          expect((yield* inspect(config)).revisions).toEqual(before.revisions);
          expect(yield* service.getAssetMetadata({ ...env, assetId: first.asset.assetId })).toEqual(
            first.asset,
          );
        }).pipe(Effect.provide(live()), Effect.scoped);
      }),
    ),
);

it.effect.each(["conflicting_pin", "asset_unavailable"] as const)(
  "retains a reconciled %s finding through a shape-preserving media move",
  (reason) =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const { service, pageId, request } = yield* boot();
        const a = yield* upload("move-issue-a");
        const b = yield* upload(
          "move-issue-b",
          new TextEncoder().encode("%PDF-1.7\n% distinct original\n%%EOF\n"),
        );
        expect(a.digest).not.toBe(b.digest);
        yield* service.applyBlockBatch(
          request("move-issue-seed", 0, [{ kind: "insert", block: media("a", a.assetId) }]),
        );
        const library = yield* service.listSpaces(env);
        const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
        const destinationPage = yield* service.createPage({
          ...common,
          mutationId: "move-issue-page",
          title: "Destination",
          spaceId: library.defaultSpaceId,
          baseRootOrderRevision: (yield* service.listPages({
            ...env,
            spaceId: library.defaultSpaceId,
          })).space.rootOrderRevision,
        });
        if (destinationPage.status !== "saved") return yield* Effect.die("Expected destination");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          if (reason === "conflicting_pin")
            yield* sql`UPDATE spaces_block_asset_refs SET asset_id=${b.assetId} WHERE block_id='a'`;
          else
            yield* sql`UPDATE spaces_assets SET state='deleted',deleted_at_ms=0 WHERE asset_id=${a.assetId}`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        for (const _pass of Array.from({ length: 16 }, (_, i) => i)) yield* service.maintainAssets;
        const before = yield* progress(config);
        expect(before.issues).toEqual([{ kind: "block", entity: "a", reason }]);
        expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
          currentPending: false,
          historyPending: false,
          unresolved: true,
          gcEnabled: false,
        });
        const destination = {
          pageId: destinationPage.page.id,
          parentId: null,
          beforeBlockId: null,
        };
        const blockIds = [C.SpaceBlockId.make("a")];
        const plan = yield* service.inspectStructure({
          ...env,
          target: { kind: "blocks", pageId, blockIds },
          destination: { kind: "child", placement: destination },
        });
        const intent = {
          ...common,
          mutationId: "move-issue-move",
          sourcePageId: pageId,
          blockIds,
          destination,
          guards: plan.guards,
        };
        const moved = yield* service.moveBlocks(intent);
        expect(moved.status).toBe("saved");
        expect((yield* progress(config)).issues).toEqual(before.issues);
        expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
          unresolved: true,
          gcEnabled: false,
        });
        const state = yield* inspect(config);
        expect(state.current).toEqual([
          { block_id: "a", asset_id: reason === "conflicting_pin" ? b.assetId : a.assetId },
        ]);
        if (reason === "conflicting_pin")
          expect(state.history.some((pin) => pin.asset_id === a.assetId)).toBe(false);
        expect(yield* service.moveBlocks(intent)).toEqual(moved);
        expect((yield* progress(config)).issues).toEqual(before.issues);
      }).pipe(Effect.provide(live())),
    ),
);

it.effect(
  "refuses a 101-row partial legacy pin repair and prunes the retained 100-row unit before later history",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const { service, pageId, request } = yield* boot();
        const assets: C.SpaceAssetMetadata[] = [];
        for (let i = 0; i < 99; i++) assets.push(yield* upload(`cleanup-unit-${i}`));
        const blocks = assets.map((asset, i) =>
          media(i.toString(16).padStart(3, "0"), asset.assetId),
        );
        expect(
          (yield* service.applyBlockBatch(
            request(
              "cleanup-unit-insert",
              0,
              blocks.map((block) => ({ kind: "insert", block })),
            ),
          )).status,
        ).toBe("saved");
        expect(
          (yield* service.applyBlockBatch(
            request(
              "cleanup-unit-delete",
              1,
              blocks.map((block) => ({ kind: "delete", blockId: block.id })),
            ),
          )).status,
        ).toBe("saved");
        const common = {
          ...env,
          receiptEpoch: (yield* service.listSpaces(env)).mutationAdmission.epoch,
        };
        expect(
          (yield* service.updatePage({
            ...common,
            mutationId: "cleanup-unit-later",
            pageId,
            baseRevision: 2,
            title: "Later history",
          })).status,
        ).toBe("saved");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<{
            readonly mutation_id: string;
            readonly created_at_ms: number;
            readonly expires_at_ms: number;
            readonly payload: string;
            readonly logical_bytes: number;
          }>`SELECT * FROM spaces_revisions WHERE page_id=${pageId} AND to_revision=2`;
          const old = JSON.parse(row!.payload);
          const unknown = JSON.stringify({ ...text("legacy-unknown"), type: "future", version: 2 });
          const payload = JSON.stringify({
            ...old,
            blocksBefore: [
              ...old.blocksBefore,
              {
                id: "legacy-unknown",
                row: {
                  block_id: "legacy-unknown",
                  page_id: pageId,
                  parent_id: null,
                  rank: "f".repeat(32),
                  payload: unknown,
                  logical_bytes: Buffer.byteLength(unknown),
                  deleted: 0,
                  merged_into: null,
                },
              },
            ],
          });
          const ids = assets.map((asset) => asset.assetId).sort();
          const retained = ids.slice(0, 98);
          const size = Buffer.byteLength(
            JSON.stringify({
              pageId,
              toRevision: 2,
              mutationId: row!.mutation_id,
              createdAtMs: row!.created_at_ms,
              expiresAtMs: row!.expires_at_ms,
              payload,
              assetIds: retained,
            }),
          );
          const delta = size - row!.logical_bytes;
          yield* sql`DELETE FROM spaces_revision_asset_refs WHERE page_id=${pageId} AND to_revision=2 AND asset_id=${ids[98]!}`;
          yield* sql`UPDATE spaces_revisions SET payload=${payload},asset_count=98,logical_bytes=${size} WHERE page_id=${pageId} AND to_revision=2`;
          yield* sql`UPDATE spaces_pages SET retained_revision_bytes=retained_revision_bytes+${delta} WHERE page_id=${pageId}`;
          yield* sql`UPDATE spaces_core SET revision_bytes=revision_bytes+${delta}`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        const before = yield* inspect(config);
        expect(before.history).toHaveLength(98);
        for (const _pass of [0, 1, 2, 3, 4, 5]) yield* service.maintainAssets;
        expect((yield* inspect(config)).history).toHaveLength(98);
        expect(yield* inspect(config)).toEqual(before);
        expect((yield* progress(config)).issues).toEqual([
          { kind: "history", entity: JSON.stringify([pageId, 2]), reason: "capacity" },
        ]);
        expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
          historyPending: false,
          unresolved: true,
          gcEnabled: false,
        });
        yield* TestClock.adjust("8 days");
        yield* service.getPage({ ...env, pageId });
        expect((yield* inspect(config)).revisions.map((row) => row.to_revision)).toEqual([2, 3]);
        yield* service.getPage({ ...env, pageId });
        const afterBoundary = yield* inspect(config);
        expect(afterBoundary.revisions.map((row) => row.to_revision)).toEqual([3]);
        expect(afterBoundary.history).toEqual([]);
        expect((yield* progress(config)).issues).toEqual([]);
        yield* service.getPage({ ...env, pageId });
        const pruned = yield* inspect(config);
        expect(pruned.revisions).toEqual([]);
        expect(pruned.core[0]?.revision_bytes).toBe(0);
        expect(pruned.pages[0]?.retained_revision_count).toBe(0);
        expect(pruned.pages[0]?.retained_revision_bytes).toBe(0);
        expect(yield* service.getAssetMetadata({ ...env, assetId: assets[0]!.assetId })).toEqual(
          assets[0],
        );
      }).pipe(Effect.provide(live())),
    ),
);
