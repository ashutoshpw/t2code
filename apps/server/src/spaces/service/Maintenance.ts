import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as Catalog from "../assets/Catalog.ts";
import * as Reconciliation from "../assets/Reconciliation.ts";
import * as GC from "../assets/GC.ts";
import { limits } from "../CorePolicy.ts";
import * as Receipts from "../Receipts.ts";
import * as SpacesSql from "../SpacesSql.ts";
import { assetErrors } from "./Helpers.ts";
import type { Runtime } from "./Runtime.ts";

export const make = (rt: Runtime) => {
  const {
    settings,
    identity,
    platform,
    dbPath,
    mutex,
    acquiredSql,
    fs,
    assetDirectories,
    activeUploads,
    collectionOwner,
    inventory,
    maintenanceMutex,
    recover,
    acquire,
    admit,
    checkEnvironment,
    run,
    leaseUpload,
    releaseUpload,
    startupRecoveryGeneration,
  } = rt;
  const getCapability = Effect.fn("SpacesService.getCapability")(
    function* (requested: EnvironmentId) {
      const environmentId = yield* admit();
      yield* checkEnvironment(environmentId, requested);
      return yield* run(environmentId, (meta) =>
        Effect.gen(function* () {
          yield* Receipts.issue(meta);
          const assetRecoveryPending =
            yield* Catalog.hasRecoveryPending(activeUploads).pipe(assetErrors);
          return {
            version: 2,
            limits,
            assetRecoveryPending,
            assetReconciliation: yield* Reconciliation.status(),
            features: {
              pins: true,
              recents: true,
              assetList: true,
              allPages: true,
              blockMoves: true,
              referenceResolution: true,
              recovery: true,
              search: true,
              assets: true,
              contextCapture: true,
              databases: true,
            },
          } satisfies C.SpaceCapability;
        }),
      );
    },
    Effect.catchTags({
      SpacesDisabledError: () => Effect.succeed(null),
      SpacesUnavailableError: () => Effect.succeed(null),
    }),
  );
  const reclaimExistingStorage = Effect.fn("SpacesService.reclaimExistingStorage")(function* () {
    for (let page = 0; page < 64; page++) {
      const reclaimed = yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(acquiredSql);
          if (Option.isNone(current)) return false;
          const snapshot = yield* settings.getSettings.pipe(
            Effect.mapError(() => new C.SpacesUnavailableError({ stage: "settings" })),
          );
          if (!snapshot.spacesEnabled) return false;
          const sql = current.value;
          const [mode] = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
          if (mode?.auto_vacuum !== 2) return false;
          const [free] = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
          if (!free || free.freelist_count === 0) return false;
          yield* sql`PRAGMA incremental_vacuum(1)`;
          return true;
        }),
      );
      if (!reclaimed) return;
      yield* Effect.yieldNow;
    }
  }, assetErrors);
  const maintainAssets = maintenanceMutex.withPermits(1)(
    Effect.gen(function* () {
      const snapshot = yield* settings.getSettings.pipe(
        Effect.mapError(() => new C.SpacesUnavailableError({ stage: "settings" })),
      );
      if (!snapshot.spacesEnabled) return null;
      const environmentId = yield* identity.getEnvironmentId;
      const beforeStartup = startupRecoveryGeneration();
      const sql = yield* acquire;
      const collectionTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        mutex.withPermits(1)(
          sql.withTransaction(effect).pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
        );
      const collection = yield* collectionTransaction(
        Effect.gen(function* () {
          yield* admit();
          const meta = yield* Receipts.observe(environmentId);
          if (beforeStartup !== startupRecoveryGeneration())
            return { handled: true, ticket: null, staged: undefined, now: meta.observed_time_ms };
          const plan = yield* GC.plan(collectionOwner, meta.observed_time_ms);
          const staged = plan.handled
            ? { handled: false, row: undefined }
            : yield* GC.staging(collectionOwner, meta.observed_time_ms, activeUploads);
          return {
            ...plan,
            handled: plan.handled || staged.handled,
            staged: staged.row,
            now: meta.observed_time_ms,
          };
        }),
      ).pipe(assetErrors);
      if (collection.ticket)
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const ticket = collection.ticket!;
            yield* collectionTransaction(GC.assertTicket(ticket));
            const proof = yield* GC.erase(ticket, assetDirectories.assetsDir).pipe(
              Effect.provide(platform),
              Effect.provideService(SpacesSql.SpacesSql, sql),
              Effect.result,
            );
            if (proof._tag === "Failure") yield* collectionTransaction(GC.failed(ticket));
            else yield* collectionTransaction(GC.complete(ticket, proof.success, collection.now));
          }),
        ).pipe(assetErrors);
      if (collection.staged) {
        const row = collection.staged;
        yield* Effect.acquireUseRelease(
          leaseUpload(row.upload_id),
          () =>
            Effect.uninterruptible(
              recover(row, collection.now).pipe(
                Effect.provide(platform),
                Effect.provideService(SpacesSql.SpacesSql, sql),
                Effect.andThen(
                  collectionTransaction(Reconciliation.issue("staging", row.upload_id, null)),
                ),
                Effect.catch(() =>
                  collectionTransaction(
                    Reconciliation.issue("staging", row.upload_id, "cleanup_failed"),
                  ),
                ),
              ),
            ),
          () => releaseUpload(row.upload_id),
        ).pipe(assetErrors);
      }
      const progress = collection.handled
        ? yield* collectionTransaction(Reconciliation.state()).pipe(assetErrors)
        : yield* run(environmentId, (meta) =>
            Effect.gen(function* () {
              const sql = yield* SpacesSql.SpacesSql;
              const current = yield* Reconciliation.state();
              if (
                current.blocks_done &&
                current.history_done &&
                current.blobs_done &&
                current.assets_done &&
                current.staging_done &&
                meta.observed_time_ms - current.cycle_started_ms >= 86_400_000
              )
                yield* sql`UPDATE spaces_asset_reconciliation SET block_cursor = '',blocks_done = 0,history_page = '',history_revision = -1,history_done = 0,
            blob_cursor = '',blobs_done = 0,assets_done = 0,staging_done = 0,cycle_started_ms = ${meta.observed_time_ms} WHERE singleton = 1`;
              return yield* Reconciliation.state();
            }),
          );
      if (collection.handled) {
        // This opportunity spent its bounded work on collection, not another maintenance prefix.
      } else if (!progress.blocks_done || !progress.history_done) {
        yield* run(environmentId, () => Reconciliation.referencesPass());
      } else if (!progress.blobs_done) {
        const [blob] = yield* run(environmentId, () =>
          Effect.gen(function* () {
            const sql = yield* SpacesSql.SpacesSql;
            return yield* sql<{
              readonly digest: string;
              readonly byte_size: number;
              readonly generation: number;
              readonly state: string;
              readonly mime_type: string;
              readonly media_kind: string;
            }>`
          SELECT digest,byte_size,generation,state,mime_type,media_kind FROM spaces_asset_blobs WHERE state='ready' AND digest > ${progress.blob_cursor} ORDER BY digest LIMIT 1`;
          }),
        );
        const valid = blob ? yield* inventory.verify(blob) : true;
        yield* run(environmentId, () =>
          Effect.gen(function* () {
            const sql = yield* SpacesSql.SpacesSql;
            if (!blob)
              yield* sql`UPDATE spaces_asset_reconciliation SET blobs_done = 1 WHERE singleton = 1`;
            else {
              const [current] = yield* sql<{
                readonly generation: number;
                readonly state: string;
              }>`SELECT generation,state FROM spaces_asset_blobs WHERE digest = ${blob.digest}`;
              if (current?.generation === blob.generation && current.state === blob.state)
                yield* Reconciliation.issue(
                  "blob",
                  blob.digest,
                  blob.state === "ready" && valid ? null : "unavailable_file",
                );
              yield* sql`UPDATE spaces_asset_reconciliation SET blob_cursor = ${blob.digest} WHERE singleton = 1`;
            }
          }),
        );
      } else {
        const now = yield* run(environmentId, (meta) => Effect.succeed(meta.observed_time_ms));
        for (const kind of ["assets", "staging"] as const) {
          if ((kind === "assets" ? progress.assets_done : progress.staging_done) === 1) continue;
          const found = yield* inventory
            .discover(
              kind,
              now,
              kind === "assets" ? progress.assets_generation : progress.staging_generation,
            )
            .pipe(Effect.mapError(() => new C.SpacesUnavailableError({ stage: "storage" })));
          yield* run(environmentId, () =>
            Effect.gen(function* () {
              const sql = yield* SpacesSql.SpacesSql;
              for (const entry of found.entries) yield* inventory.record(entry);
              if (found.done) {
                if (kind === "assets")
                  yield* sql`UPDATE spaces_asset_reconciliation SET assets_done = 1 WHERE singleton = 1 AND assets_generation = ${found.generation}`;
                else
                  yield* sql`UPDATE spaces_asset_reconciliation SET staging_done = 1 WHERE singleton = 1 AND staging_generation = ${found.generation}
                    AND NOT EXISTS (SELECT 1 FROM spaces_asset_uploads WHERE state = 'receiving')`;
              }
            }),
          );
          yield* inventory.acknowledge(kind);
        }
        const entries = yield* run(environmentId, () =>
          Effect.gen(function* () {
            const sql = yield* SpacesSql.SpacesSql;
            return yield* sql<{
              readonly kind: string;
              readonly name: string;
            }>`SELECT kind,name FROM spaces_asset_file_observations
          WHERE (kind,name) > (${progress.file_kind},${progress.file_cursor}) ORDER BY kind,name LIMIT 8`;
          }),
        );
        const observations = yield* inventory
          .refresh(entries, now)
          .pipe(Effect.mapError(() => new C.SpacesUnavailableError({ stage: "storage" })));
        yield* run(environmentId, () =>
          Effect.gen(function* () {
            const sql = yield* SpacesSql.SpacesSql;
            for (const entry of observations) yield* inventory.record(entry);
            const last = entries.at(-1);
            yield* sql`UPDATE spaces_asset_reconciliation SET file_kind = ${last?.kind ?? ""},file_cursor = ${last?.name ?? ""} WHERE singleton = 1`;
          }),
        );
      }
      const readAccounting = Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        const usage = yield* Catalog.usage().pipe(assetErrors);
        const current = yield* Reconciliation.state();
        const [free] = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
        const [size] = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
        const [mode] = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
        return {
          reclaimableBytes: (free?.freelist_count ?? 0) * (size?.page_size ?? 0),
          incrementalVacuumEnabled: mode?.auto_vacuum === 2,
          registeredAssetBytes: usage.physical_bytes,
          reservedBytes: usage.reserved_bytes,
          observedAssetFileBytes: current.assets_bytes,
          observedStagingFileBytes: current.staging_bytes,
          observedAt: current.observed_at_ms,
          reconciliation: yield* Reconciliation.status(),
        };
      });
      const accounting = collection.handled
        ? yield* collectionTransaction(readAccounting).pipe(assetErrors)
        : yield* run(environmentId, () => readAccounting);
      const bytes = (file: string) =>
        fs.stat(file).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.mapError(() => new C.SpacesUnavailableError({ stage: "storage" })),
        );
      return {
        ...accounting,
        databaseBytes: yield* bytes(dbPath),
        walBytes: yield* bytes(`${dbPath}-wal`).pipe(Effect.orElseSucceed(() => 0)),
        sharedMemoryBytes: yield* bytes(`${dbPath}-shm`).pipe(Effect.orElseSucceed(() => 0)),
      };
    }),
  );
  return {
    getCapability,
    reclaimExistingStorage,
    maintainAssets,
  };
};
