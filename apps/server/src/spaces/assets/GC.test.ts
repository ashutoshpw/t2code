import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as Config from "../../config.ts";
import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as Identity from "../../environment/ServerEnvironment.ts";
import * as Settings from "../../serverSettings.ts";
import * as Service from "../SpacesService.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as GC from "./GC.ts";
import * as Reconciliation from "./Reconciliation.ts";

const environmentId = EnvironmentId.make("collection-tests");
const env = { environmentId };
const pdf = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const fixture = Effect.fn("SpacesCollectionTest.fixture")(function* <A, E, R>(
  use: (input: {
    readonly config: Config.ServerConfig["Service"];
    readonly live: () => ReturnType<typeof Service.layerFromPath>;
  }) => Effect.Effect<A, E, R>,
) {
  const context = yield* Layer.buildWithScope(
    Config.ServerConfig.layerTest(process.cwd(), { prefix: "spaces-gc-" }),
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
        Settings.layerTest({ spacesEnabled: true }),
        Secrets.layer.pipe(Layer.provide(Layer.succeedContext(context))),
        Layer.succeed(Identity.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
    ),
  );
}, Effect.provide(NodeServices.layer));
const upload = Effect.fn("SpacesCollectionTest.upload")(function* (id: string, data = pdf) {
  const service = yield* Service.SpacesService;
  const intent = yield* service.createAssetUpload(
    {
      ...env,
      requestId: id,
      expectedBytes: data.length,
      mediaKind: "pdf",
      mimeType: "application/pdf",
      name: "paper.pdf",
    },
    "owner",
  );
  yield* service.receiveAssetUpload(
    intent.relativeUrl.slice(intent.relativeUrl.lastIndexOf("/") + 1),
    String(data.length),
    Stream.make(data),
  );
  return {
    intent,
    asset: yield* service.finalizeAssetUpload({ ...env, uploadId: intent.uploadId }, "owner"),
  };
});
const settle = Effect.fn("SpacesCollectionTest.settle")(function* () {
  const service = yield* Service.SpacesService;
  for (const _pass of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) yield* service.maintainAssets;
});
const inspect = Effect.fn("SpacesCollectionTest.inspect")(function* (
  config: Config.ServerConfig["Service"],
) {
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      blobs: yield* sql<{
        readonly digest: string;
        readonly byte_size: number;
        readonly state: string;
        readonly generation: number;
        readonly grace_epoch: number;
        readonly physical_charged: number;
        readonly unreferenced_at_ms: number | null;
        readonly deletion_attempt: string | null;
      }>`SELECT * FROM spaces_asset_blobs ORDER BY digest`,
      usage: (yield* sql<{
        readonly physical_bytes: number;
        readonly reserved_bytes: number;
        readonly pending_count: number;
      }>`SELECT * FROM spaces_asset_usage`)[0]!,
      collection: (yield* sql<{
        readonly last_work_rows: number;
        readonly last_planned_bytes: number;
        readonly owner_token: string;
      }>`SELECT * FROM spaces_asset_collection`)[0]!,
      refs: yield* sql`SELECT block_id,asset_id FROM spaces_block_asset_refs`,
      history: yield* sql`SELECT page_id,to_revision,asset_id FROM spaces_revision_asset_refs`,
      blocks: yield* sql`SELECT * FROM spaces_blocks`,
      receipts: yield* sql`SELECT * FROM spaces_receipts`,
    };
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath, readonly: true })),
  );
});
const page = Effect.fn("SpacesCollectionTest.page")(function* (
  mutationId = "page",
  baseRootOrderRevision = 0,
) {
  const service = yield* Service.SpacesService;
  const library = yield* service.listSpaces(env);
  const result = yield* service.createPage({
    ...env,
    receiptEpoch: library.mutationAdmission.epoch,
    mutationId,
    spaceId: library.defaultSpaceId,
    baseRootOrderRevision,
    title: "Pinned",
  });
  if (result.status !== "saved") return yield* Effect.die("Expected page");
  return result.page.id;
});
const insert = Effect.fn("SpacesCollectionTest.insert")(function* (
  pageId: C.SpacePageId,
  assetId: C.SpaceAssetId,
  unknown = false,
  id = unknown ? "unknown" : "known",
) {
  const service = yield* Service.SpacesService;
  const library = yield* service.listSpaces(env);
  const current = (yield* service.getPage({ ...env, pageId })).page;
  return yield* service.applyBlockBatch({
    ...env,
    receiptEpoch: library.mutationAdmission.epoch,
    mutationId: id,
    pageId,
    baseRevision: current.revision,
    generation: 0,
    mutations: [
      {
        kind: "insert",
        block: unknown
          ? {
              id: C.SpaceBlockId.make(id),
              parentId: null,
              order: "2".padStart(32, "0"),
              type: "paragraph",
              version: 1,
              content: { runs: [] },
              future: { assetId },
            }
          : {
              id: C.SpaceBlockId.make(id),
              parentId: null,
              order: "1".padStart(32, "0"),
              type: "pdf",
              version: 1,
              content: { assetId },
            },
      },
    ],
  });
});

it.effect(
  "starts grace at observed zero references and fences clock rollback and old generations",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const service = yield* Service.SpacesService;
        const first = yield* upload("first");
        yield* settle();
        expect((yield* inspect(config)).blobs[0]?.unreferenced_at_ms).toBe(0);
        yield* TestClock.adjust("23 hours");
        yield* service.maintainAssets;
        expect((yield* inspect(config)).blobs[0]?.state).toBe("ready");
        yield* TestClock.setTime(0);
        yield* service.maintainAssets;
        expect((yield* inspect(config)).blobs[0]?.state).toBe("ready");
        yield* TestClock.setTime(86_400_000);
        yield* service.maintainAssets;
        expect((yield* inspect(config)).blobs[0]).toMatchObject({
          state: "deleted",
          generation: 1,
          physical_charged: 0,
        });
        expect((yield* inspect(config)).usage.physical_bytes).toBe(0);
        const second = yield* upload("second");
        expect(second.asset.digest).toBe(first.asset.digest);
        expect(second.asset.assetId).not.toBe(first.asset.assetId);
        expect(
          yield* service
            .getAssetMetadata({ ...env, assetId: first.asset.assetId })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "not_found" });
        expect(
          yield* service.finalizeAssetUpload({ ...env, uploadId: first.intent.uploadId }, "owner"),
        ).toEqual(first.asset);
        expect(yield* service.getAssetMetadata({ ...env, assetId: second.asset.assetId })).toEqual(
          second.asset,
        );
        expect((yield* inspect(config)).blobs[0]?.generation).toBe(2);
        const fs = yield* FileSystem.FileSystem;
        expect(
          new Uint8Array(yield* fs.readFile(`${config.spacesAssetsDir}/${second.asset.digest}`)),
        ).toEqual(pdf);
      }).pipe(Effect.provide(live())),
    ),
);

it.effect.each([false, true])(
  "reference admission before collection protects bytes (unknown=%s)",
  (unknown) =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const service = yield* Service.SpacesService;
        const p = yield* page();
        const ready = yield* upload("pinned");
        yield* settle();
        yield* TestClock.adjust("23 hours");
        expect((yield* insert(p, ready.asset.assetId, unknown)).status).toBe("saved");
        yield* TestClock.adjust("2 hours");
        yield* settle();
        expect((yield* inspect(config)).blobs[0]?.state).toBe("ready");
        expect((yield* inspect(config)).usage.physical_bytes).toBe(pdf.length);
        if (unknown)
          expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
            unresolved: true,
            gcEnabled: false,
          });
        else expect((yield* inspect(config)).refs).toHaveLength(1);
      }).pipe(Effect.provide(live())),
    ),
);

it.effect(
  "fences references and interruption while unlink is pending, then republishes only after settlement",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const started = yield* Deferred.make<void>(),
          allow = yield* Deferred.make<void>();
        let removes = 0;
        yield* Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          const p = yield* page(),
            ready = yield* upload("pending");
          yield* settle();
          yield* TestClock.adjust("24 hours");
          const worker = yield* service.maintainAssets.pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          expect((yield* inspect(config)).blobs[0]?.state).toBe("deleting");
          const before = yield* inspect(config);
          expect(yield* insert(p, ready.asset.assetId).pipe(Effect.flip)).toMatchObject({
            reason: "not_found",
          });
          expect(yield* insert(p, ready.asset.assetId, true).pipe(Effect.flip)).toMatchObject({
            reason: "blob_unavailable",
          });
          const after = yield* inspect(config);
          expect(after.blocks).toEqual(before.blocks);
          expect(after.refs).toEqual(before.refs);
          expect(after.history).toEqual(before.history);
          const interruption = yield* Fiber.interrupt(worker).pipe(Effect.forkScoped);
          expect((yield* inspect(config)).blobs[0]?.state).toBe("deleting");
          const retry = yield* service.createAssetUpload(
            {
              ...env,
              requestId: "retry",
              expectedBytes: pdf.length,
              mediaKind: "pdf",
              mimeType: "application/pdf",
              name: "retry.pdf",
            },
            "owner",
          );
          const token = retry.relativeUrl.slice(retry.relativeUrl.lastIndexOf("/") + 1);
          expect(
            yield* service
              .receiveAssetUpload(token, String(pdf.length), Stream.make(pdf))
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "blob_unavailable" });
          const queued = yield* service.maintainAssets.pipe(Effect.forkScoped);
          expect(removes).toBe(1);
          yield* Deferred.succeed(allow, undefined);
          yield* Fiber.await(worker);
          yield* Fiber.join(queued);
          yield* Fiber.join(interruption);
          expect((yield* inspect(config)).blobs[0]?.state).toBe("deleted");
          const next = yield* service.receiveAssetUpload(
            token,
            String(pdf.length),
            Stream.make(pdf),
          );
          expect(next.assetId).toBe(retry.assetId);
          expect(removes).toBe(1);
          expect(
            new Uint8Array(yield* fs.readFile(`${config.spacesAssetsDir}/${ready.asset.digest}`)),
          ).toEqual(pdf);
        }).pipe(
          Effect.ensuring(Deferred.succeed(allow, undefined)),
          Effect.provide(live()),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            remove: (filename, options) =>
              filename.startsWith(config.spacesAssetsDir + "/")
                ? Effect.sync(() => {
                    removes++;
                  }).pipe(
                    Effect.andThen(Deferred.succeed(started, undefined)),
                    Effect.andThen(Deferred.await(allow)),
                    Effect.andThen(fs.remove(filename, options)),
                  )
                : fs.remove(filename, options),
          }),
        );
      }),
    ),
);

it.effect.each(["before-unlink", "after-unlink"] as const)(
  "recovers %s without releasing physical charge before absence completion",
  (boundary) =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const first = yield* Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          const ready = yield* upload("restart");
          yield* settle();
          yield* TestClock.adjust("24 hours");
          if (boundary === "before-unlink") yield* fs.chmod(config.spacesAssetsDir, 0o500);
          else
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`CREATE TRIGGER refuse_collection BEFORE UPDATE OF state ON spaces_asset_blobs WHEN NEW.state='deleted' BEGIN SELECT RAISE(ABORT,'lost completion'); END`;
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
          const result = yield* service.maintainAssets.pipe(Effect.result);
          if (boundary === "after-unlink") expect(result._tag).toBe("Failure");
          const state = yield* inspect(config);
          expect(state.blobs[0]).toMatchObject({ state: "deleting", physical_charged: 1 });
          expect(state.usage.physical_bytes).toBe(pdf.length);
          expect(yield* fs.exists(`${config.spacesAssetsDir}/${ready.asset.digest}`)).toBe(
            boundary === "before-unlink",
          );
          yield* fs.chmod(config.spacesAssetsDir, 0o700);
          return ready;
        }).pipe(Effect.provide(live()), Effect.scoped);
        if (boundary === "after-unlink")
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DROP TRIGGER refuse_collection`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        yield* Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          yield* service.maintainAssets;
          const state = yield* inspect(config);
          expect(state.blobs[0]).toMatchObject({ state: "deleted", physical_charged: 0 });
          expect(state.usage.physical_bytes).toBe(0);
          yield* service.maintainAssets;
          expect((yield* inspect(config)).usage.physical_bytes).toBe(0);
          expect(
            yield* service
              .getAssetMetadata({ ...env, assetId: first.asset.assetId })
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "not_found" });
        }).pipe(Effect.provide(live()), Effect.scoped);
      }),
    ),
);

it.effect(
  "retires an erase ticket permanently and makes repeated completion harmless after digest reuse",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const first = yield* upload("ticket");
        yield* settle();
        yield* TestClock.adjust("24 hours");
        const raw = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const owner = (yield* inspect(config)).collection.owner_token;
          return yield* sql.withTransaction(
            GC.plan(owner, 86_400_000).pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        const selected = yield* raw;
        if (!selected.ticket) return yield* Effect.die("Expected deletion ticket");
        const ticket = selected.ticket;
        const proof = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const proof = yield* GC.erase(ticket, config.spacesAssetsDir).pipe(
            Effect.provideService(SpacesSql.SpacesSql, sql),
          );
          yield* sql.withTransaction(
            GC.complete(ticket, proof, 86_400_000).pipe(
              Effect.provideService(SpacesSql.SpacesSql, sql),
            ),
          );
          yield* sql.withTransaction(
            GC.complete(ticket, proof, 86_400_000).pipe(
              Effect.provideService(SpacesSql.SpacesSql, sql),
            ),
          );
          return proof;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        const next = yield* upload("ticket-next");
        expect(next.asset.digest).toBe(first.asset.digest);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect(
            yield* GC.erase(ticket, config.spacesAssetsDir).pipe(
              Effect.provideService(SpacesSql.SpacesSql, sql),
              Effect.flip,
            ),
          ).toMatchObject({ _tag: "SpacesUnavailableError" });
          yield* sql.withTransaction(
            GC.complete(ticket, proof, 86_400_000).pipe(
              Effect.provideService(SpacesSql.SpacesSql, sql),
            ),
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        expect((yield* inspect(config)).usage.physical_bytes).toBe(pdf.length);
        const fs = yield* FileSystem.FileSystem;
        expect(
          new Uint8Array(yield* fs.readFile(`${config.spacesAssetsDir}/${next.asset.digest}`)),
        ).toEqual(pdf);
      }).pipe(Effect.provide(live())),
    ),
);

const recovery = Effect.fn("SpacesCollectionTest.recovery")(function* (
  pageId: C.SpacePageId,
  operation: C.SpaceRecoveryOperation,
  id: string,
) {
  const service = yield* Service.SpacesService;
  const library = yield* service.listSpaces(env);
  const inspected = yield* service.inspectStructure({
    ...env,
    target: { kind: "page", pageId },
    recovery: operation,
  });
  const input = {
    ...env,
    pageId,
    receiptEpoch: library.mutationAdmission.epoch,
    guards: inspected.guards,
    mutationId: id,
  };
  return operation === "trash"
    ? yield* service.trashPage(input)
    : operation === "restore"
      ? yield* service.restorePage(input)
      : yield* service.permanentlyDeletePage(input);
});
it.effect(
  "retains shared trash and history pins and starts a new full grace only after their final removal",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const service = yield* Service.SpacesService;
        const ready = yield* upload("shared");
        const p = yield* page();
        yield* insert(p, ready.asset.assetId, false, "first");
        const q = yield* page("second-page", 1);
        yield* insert(q, ready.asset.assetId, false, "second");
        yield* recovery(q, "trash", "trash");
        yield* settle();
        yield* TestClock.adjust("25 hours");
        yield* settle();
        expect((yield* inspect(config)).blobs[0]?.state).toBe("ready");
        yield* recovery(q, "restore", "restore");
        yield* recovery(q, "trash", "retrash");
        yield* recovery(q, "permanentlyDelete", "purge");
        expect((yield* inspect(config)).refs).toEqual([
          { block_id: "first", asset_id: ready.asset.assetId },
        ]);
        const current = yield* service.getPage({ ...env, pageId: p });
        yield* service.applyBlockBatch({
          ...env,
          receiptEpoch: current.mutationAdmission.epoch,
          mutationId: "delete-current",
          pageId: p,
          baseRevision: current.page.revision,
          generation: 0,
          mutations: [{ kind: "delete", blockId: C.SpaceBlockId.make("first") }],
        });
        expect((yield* inspect(config)).refs).toEqual([]);
        expect((yield* inspect(config)).history.map((row) => row.asset_id)).toContain(
          ready.asset.assetId,
        );
        yield* settle();
        expect((yield* inspect(config)).blobs[0]?.unreferenced_at_ms).toBeNull();
        yield* TestClock.adjust("8 days");
        yield* service.getPage({ ...env, pageId: p });
        expect((yield* inspect(config)).history).toEqual([]);
        yield* settle();
        const observed = (yield* inspect(config)).blobs[0]?.unreferenced_at_ms;
        expect(observed).toBe(25 * 3600000 + 8 * 86400000);
        yield* TestClock.adjust("23 hours");
        yield* service.maintainAssets;
        expect((yield* inspect(config)).blobs[0]?.state).toBe("ready");
        yield* TestClock.adjust("1 hour");
        yield* service.maintainAssets;
        expect((yield* inspect(config)).blobs[0]?.state).toBe("deleted");
      }).pipe(Effect.provide(live())),
    ),
);

it.effect(
  "prevents a second service scope from stealing a live owner and keeps the original owner usable",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          yield* upload("owner");
          yield* settle();
          yield* TestClock.adjust("24 hours");
          yield* Effect.gen(function* () {
            const other = yield* Service.SpacesService;
            yield* other.maintainAssets;
            expect((yield* inspect(config)).blobs[0]?.state).toBe("ready");
          }).pipe(Effect.provide(live()), Effect.scoped);
          yield* service.maintainAssets;
          expect((yield* inspect(config)).blobs[0]?.state).toBe("deleted");
        }).pipe(Effect.provide(live()), Effect.scoped);
        yield* Effect.gen(function* () {
          yield* settle();
          expect((yield* inspect(config)).blobs[0]?.state).toBe("deleted");
        }).pipe(Effect.provide(live()), Effect.scoped);
      }),
    ),
);

it.effect(
  "bounds candidate progress and deletes one file per opportunity while reporting the remaining backlog",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const service = yield* Service.SpacesService;
        for (let i = 0; i < 101; i++)
          yield* upload(`batch-${i}`, new TextEncoder().encode(`%PDF-1.7\n${i}\n%%EOF\n`));
        // One file audit per opportunity; this is a fixed workload, not a completion polling loop.
        for (let i = 0; i < 140; i++) yield* service.maintainAssets;
        let before = yield* inspect(config);
        expect(before.blobs.filter((row) => row.unreferenced_at_ms === 0)).toHaveLength(101);
        expect(before.collection.last_work_rows).toBeLessThanOrEqual(100);
        const oldEpoch = before.blobs[0]!.grace_epoch;
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* Reconciliation.issue("probe", "bounded-prefix", "unresolved");
              yield* Reconciliation.issue("probe", "bounded-prefix", null);
            }).pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        const firstPrefix = yield* service.maintainAssets;
        expect(
          (yield* inspect(config)).blobs.filter((row) => row.grace_epoch !== oldEpoch),
        ).toHaveLength(10);
        expect(firstPrefix?.reconciliation.gcPending).toBe(true);
        for (const _pass of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) yield* service.maintainAssets;
        before = yield* inspect(config);
        expect(before.blobs.filter((row) => row.grace_epoch !== oldEpoch)).toHaveLength(101);
        yield* TestClock.adjust("24 hours");
        const report = yield* service.maintainAssets;
        const after = yield* inspect(config);
        expect(after.blobs.filter((row) => row.state === "deleted")).toHaveLength(1);
        expect(report?.reconciliation.gcPending).toBe(true);
        expect(after.collection.last_work_rows).toBeLessThanOrEqual(100);
        expect(after.collection.last_planned_bytes).toBeLessThanOrEqual(256 * 1024 ** 2);
        expect(before.usage.physical_bytes - after.usage.physical_bytes).toBe(
          after.blobs.find((row) => row.state === "deleted")!.byte_size,
        );
      }).pipe(Effect.provide(live())),
    ),
);

it.effect.each(["verified", "ready"] as const)(
  "keeps proven %s residual staging charged until its grace and owned cleanup",
  (phase) =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const service = yield* Service.SpacesService;
        const intent = yield* service.createAssetUpload(
          {
            ...env,
            requestId: "residual",
            expectedBytes: pdf.length,
            mediaKind: "pdf",
            mimeType: "application/pdf",
            name: "residual.pdf",
          },
          "owner",
        );
        // Directory permissions refuse cleanup after either verification or ready publication.
        yield* fs.makeDirectory(config.spacesStagingDir, { recursive: true });
        if (phase === "verified")
          yield* fs.writeFileString(config.spacesAssetsDir, "blocked destination");
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
                intent.relativeUrl.slice(intent.relativeUrl.lastIndexOf("/") + 1),
                String(pdf.length),
                body,
              )
              .pipe(Effect.flip),
          ).toMatchObject({ reason: phase === "verified" ? "publication_failed" : "io_failed" });
          if (phase === "verified") yield* fs.remove(config.spacesAssetsDir);
          yield* fs.chmod(config.spacesStagingDir, 0o700);
          const unknown = `${config.spacesStagingDir}/unknown.part`;
          if (phase === "verified") {
            yield* fs.writeFileString(unknown, "unknown");
            yield* fs.utimes(unknown, 0, 0);
          }
          yield* settle();
          expect((yield* inspect(config)).usage).toMatchObject({
            reserved_bytes: phase === "verified" ? pdf.length : 0,
            physical_bytes: phase === "verified" ? 0 : pdf.length,
            active_count: phase === "verified" ? 1 : 0,
            pending_count: 1,
          });
          expect(yield* fs.readDirectory(config.spacesStagingDir)).toHaveLength(
            phase === "verified" ? 2 : 1,
          );
          yield* TestClock.adjust("24 hours");
          yield* service.maintainAssets;
          expect((yield* inspect(config)).usage.pending_count).toBe(1);
          if (phase === "ready") {
            expect((yield* inspect(config)).blobs[0]).toMatchObject({
              state: "ready",
              unreferenced_at_ms: null,
            });
          }
          yield* TestClock.adjust("10 minutes");
          yield* service.maintainAssets;
          expect((yield* inspect(config)).usage).toMatchObject({
            reserved_bytes: 0,
            physical_bytes: pdf.length,
            active_count: 0,
            pending_count: 0,
          });
          expect(yield* fs.readDirectory(config.spacesStagingDir)).toEqual(
            phase === "verified" ? ["unknown.part"] : [],
          );
          yield* settle();
          expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
            unresolved: phase === "verified",
            gcEnabled: phase === "ready",
          });
          expect((yield* inspect(config)).blobs[0]?.state).toBe("ready");
        }).pipe(Effect.ensuring(fs.chmod(config.spacesStagingDir, 0o700).pipe(Effect.orDie)));
      }).pipe(Effect.provide(live())),
    ),
);

it.effect(
  "charges planned hash and unlink bytes for a real maximum-size video and refuses post-audit corruption",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const service = yield* Service.SpacesService;
        const length = 50 * 1024 ** 2;
        const header = new Uint8Array([
          0,
          0,
          0,
          24,
          ...new TextEncoder().encode("ftypisom"),
          0,
          0,
          0,
          0,
          ...new TextEncoder().encode("isommp42"),
        ]);
        const chunk = new Uint8Array(65536);
        const first = chunk.slice();
        first.set(header);
        const intent = yield* service.createAssetUpload(
          {
            ...env,
            requestId: "large-video",
            expectedBytes: length,
            mediaKind: "video",
            mimeType: "video/mp4",
            name: "clip.mp4",
          },
          "owner",
        );
        const body = Stream.make(first).pipe(
          Stream.concat(
            Stream.fromIterable(Array.from({ length: length / chunk.length - 1 }, () => chunk)),
          ),
        );
        yield* service.receiveAssetUpload(
          intent.relativeUrl.slice(intent.relativeUrl.lastIndexOf("/") + 1),
          String(length),
          body,
        );
        const asset = yield* service.finalizeAssetUpload(
          { ...env, uploadId: intent.uploadId },
          "owner",
        );
        yield* settle();
        yield* TestClock.adjust("24 hours");
        yield* service.maintainAssets;
        const completed = yield* inspect(config);
        expect(completed.collection.last_planned_bytes).toBe(100 * 1024 ** 2);
        expect(completed.collection.last_work_rows).toBeLessThanOrEqual(100);
        expect(completed.usage.physical_bytes).toBe(0);
        expect(completed.blobs.find((row) => row.digest === asset.digest)?.state).toBe("deleted");
        const changed = yield* upload("changed");
        yield* settle();
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFile(
          `${config.spacesAssetsDir}/${changed.asset.digest}`,
          new Uint8Array(pdf.length).fill(65),
        );
        yield* TestClock.adjust("24 hours");
        const report = yield* service.maintainAssets;
        expect(report?.registeredAssetBytes).toBe(pdf.length);
        expect(report?.reconciliation.gcPending).toBe(true);
        expect(
          (yield* inspect(config)).blobs.find((row) => row.digest === changed.asset.digest),
        ).toMatchObject({ state: "deleting", physical_charged: 1 });
        expect(
          new Uint8Array(yield* fs.readFile(`${config.spacesAssetsDir}/${changed.asset.digest}`)),
        ).toEqual(new Uint8Array(pdf.length).fill(65));
      }).pipe(Effect.provide(live())),
    ),
);

it.effect(
  "reconciles legacy generation projections from durable real upload proofs without rewriting authoritative pins or accounting",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const service = yield* Service.SpacesService;
        const p = yield* page(),
          ready = yield* upload("legacy-projection");
        yield* insert(p, ready.asset.assetId);
        const current = yield* service.getPage({ ...env, pageId: p });
        yield* service.applyBlockBatch({
          ...env,
          receiptEpoch: current.mutationAdmission.epoch,
          mutationId: "legacy-caption",
          pageId: p,
          baseRevision: current.page.revision,
          generation: 0,
          mutations: [
            {
              kind: "replace",
              block: {
                id: C.SpaceBlockId.make("known"),
                parentId: null,
                order: "1".padStart(32, "0"),
                type: "pdf",
                version: 1,
                content: { assetId: ready.asset.assetId, caption: [{ text: "new", marks: [] }] },
              },
            },
          ],
        });
        const before = yield* inspect(config);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE spaces_assets SET blob_generation=NULL`;
              yield* sql`UPDATE spaces_block_asset_refs SET blob_digest=NULL`;
              yield* sql`UPDATE spaces_revision_asset_refs SET blob_digest=NULL`;
              yield* sql`UPDATE spaces_asset_collection SET projection_phase='handles',projection_cursor='',projection_page='',projection_revision=-1,projection_asset=''`;
            }),
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        expect(yield* service.getAssetMetadata({ ...env, assetId: ready.asset.assetId })).toEqual(
          ready.asset,
        );
        expect((yield* service.getCapability(environmentId))?.assetReconciliation?.gcEnabled).toBe(
          false,
        );
        yield* service.maintainAssets;
        expect((yield* service.getCapability(environmentId))?.assetReconciliation?.gcEnabled).toBe(
          false,
        );
        yield* settle();
        const after = yield* inspect(config);
        expect(after.refs).toEqual(before.refs);
        expect(after.history).toEqual(before.history);
        expect(after.usage).toEqual(before.usage);
        expect(after.receipts).toEqual(before.receipts);
        expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
          unresolved: false,
          gcEnabled: true,
        });
        yield* TestClock.adjust("24 hours");
        yield* service.maintainAssets;
        expect((yield* inspect(config)).blobs[0]?.state).toBe("ready");
      }).pipe(Effect.provide(live())),
    ),
);

it.effect(
  "starts residual grace after a long live stream becomes quiescent, without reclaiming the live claim",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const service = yield* Service.SpacesService;
        const intent = yield* service.createAssetUpload(
          {
            ...env,
            requestId: "long-live",
            expectedBytes: pdf.length,
            mediaKind: "pdf",
            mimeType: "application/pdf",
            name: "long.pdf",
          },
          "owner",
        );
        const started = yield* Deferred.make<void>(),
          finish = yield* Deferred.make<void>();
        const body = Stream.make(pdf.subarray(0, 8)).pipe(
          Stream.concat(
            Stream.fromEffect(
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.andThen(fs.chmod(config.spacesStagingDir, 0o500)),
                Effect.andThen(Effect.fail("stopped")),
              ),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const receiver = yield* service
            .receiveAssetUpload(
              intent.relativeUrl.slice(intent.relativeUrl.lastIndexOf("/") + 1),
              String(pdf.length),
              body,
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* TestClock.adjust("25 hours");
          yield* service.maintainAssets;
          expect(yield* fs.readDirectory(config.spacesStagingDir)).toHaveLength(1);
          expect(
            (yield* service.getAssetUpload({ ...env, uploadId: intent.uploadId }, "owner"))
              .recoveryPending,
          ).toBe(false);
          yield* Deferred.succeed(finish, undefined);
          expect(yield* Fiber.join(receiver).pipe(Effect.flip)).toMatchObject({
            reason: "source_failed",
          });
          yield* fs.chmod(config.spacesStagingDir, 0o700);
          yield* service.maintainAssets;
          expect(yield* fs.readDirectory(config.spacesStagingDir)).toHaveLength(1);
          expect((yield* inspect(config)).usage).toMatchObject({
            reserved_bytes: pdf.length,
            active_count: 1,
            pending_count: 1,
          });
          yield* TestClock.adjust("23 hours");
          yield* service.maintainAssets;
          expect(yield* fs.readDirectory(config.spacesStagingDir)).toHaveLength(1);
          yield* TestClock.adjust("1 hour");
          yield* service.maintainAssets;
          expect(yield* fs.readDirectory(config.spacesStagingDir)).toEqual([]);
          expect((yield* inspect(config)).usage).toMatchObject({
            reserved_bytes: 0,
            physical_bytes: 0,
            active_count: 0,
            pending_count: 0,
          });
        }).pipe(Effect.ensuring(fs.chmod(config.spacesStagingDir, 0o700).pipe(Effect.orDie)));
      }).pipe(Effect.provide(live())),
    ),
);
