// @effect-diagnostics nodeBuiltinImport:off -- stable IDs are allocated by the platform cryptographic generator.
import * as NodeCrypto from "node:crypto";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as SqlError from "effect/sql/SqlError";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Catalog from "../assets/Catalog.ts";
import * as Upload from "../assets/Upload.ts";
import * as Reconciliation from "../assets/Reconciliation.ts";
import * as Inventory from "../assets/Inventory.ts";
import * as GC from "../assets/GC.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { byteLength, limits } from "../CorePolicy.ts";
import * as Receipts from "../Receipts.ts";
import * as RevisionStore from "../RevisionStore.ts";
import * as PageShares from "../PageShares.ts";
import * as ReferenceStore from "../ReferenceStore.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as SearchStore from "../SearchStore.ts";
import * as Sqlite from "../Sqlite.ts";
import { assetErrors, claimFrom, isServiceError, needsWrite } from "./Helpers.ts";

export const make = Effect.fnUntraced(function* (
  dbPath: string,
  directories?: { readonly assetsDir: string; readonly stagingDir: string },
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const scope = yield* Effect.scope;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const mutex = yield* Semaphore.make(1);
  const acquiredSql = yield* Ref.make(Option.none<SpacesSql.SpacesSql["Service"]>());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const assetDirectories = directories ?? {
    assetsDir: path.join(path.dirname(dbPath), "spaces", "assets"),
    stagingDir: path.join(path.dirname(dbPath), "spaces", "staging"),
  };
  const activeUploads = new Set<string>();
  const uploadFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
  const collectionOwner = NodeCrypto.randomUUID();
  let closing = false;
  let startupRecoveryGeneration = 0;
  let uploadsIdle = yield* Deferred.make<void>();
  yield* Deferred.succeed(uploadsIdle, undefined);
  const inventory = yield* Inventory.make(assetDirectories);
  const maintenanceMutex = yield* Semaphore.make(1);
  const recover = Effect.fn("SpacesService.recoverAsset")(
    function* (row: Catalog.UploadRow, now: number) {
      const sql = yield* SpacesSql.SpacesSql;
      const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        mutex.withPermits(1)(sql.withTransaction(effect));
      const claim = claimFrom(row);
      if (!claim || !row.attempt_owner || !(yield* GC.owns(collectionOwner)))
        return yield* new C.SpaceAssetError({ reason: "not_ready" });
      if (row.state === "receiving" && !row.staging_identity) {
        const absent = yield* Upload.confirmNoStaging(claim, assetDirectories.stagingDir);
        yield* transaction(Catalog.abort(claim, absent, now));
        return;
      }
      if (!row.staging_identity) return yield* new C.SpaceAssetError({ reason: "not_ready" });
      if (row.state === "receiving") {
        const absent = yield* Upload.discardAbandonedStaging(claim, assetDirectories);
        yield* transaction(Catalog.abort(claim, absent, now));
        return;
      }
      const recovered = yield* Upload.recoverPublication(claim, assetDirectories).pipe(
        Effect.result,
      );
      if (recovered._tag === "Failure") {
        if (recovered.failure.reason !== "missing_file") return yield* recovered.failure;
        const missing = yield* Upload.confirmMissingPublication(claim, assetDirectories);
        yield* transaction(Catalog.resetMissing(claim, missing, now));
        return;
      }
      yield* transaction(Catalog.finish(claim, recovered.success, now));
      const ready = claimFrom(yield* Catalog.getUpload(row.caller_id, row.upload_id));
      if (!ready) return yield* new C.SpaceAssetError({ reason: "not_ready" });
      const absent = yield* Upload.discardAbandonedStaging(
        ready,
        assetDirectories,
        recovered.success,
      );
      yield* transaction(Catalog.releaseStaging(ready, absent));
    },
    assetErrors,
    Effect.uninterruptible,
  );
  const acquire = yield* Effect.cached(
    Layer.buildWithScope(Sqlite.layerFromPath(dbPath), scope).pipe(
      Effect.provide(platform),
      Effect.flatMap((context) =>
        Effect.gen(function* () {
          const sql = Context.get(context, SpacesSql.SpacesSql);
          yield* sql.withTransaction(
            Reconciliation.initialize().pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
          );
          yield* sql.withTransaction(
            SearchStore.checkModule().pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
          );
          yield* sql`UPDATE spaces_asset_reconciliation SET assets_done = 0,staging_done = 0 WHERE singleton = 1`;
          const ownerAcquired = yield* sql
            .withTransaction(GC.initializeOwner(collectionOwner))
            .pipe(Effect.provideService(SpacesSql.SpacesSql, sql));
          const environmentId = yield* identity.getEnvironmentId;
          const meta = yield* sql
            .withTransaction(Receipts.observe(environmentId))
            .pipe(Effect.provideService(SpacesSql.SpacesSql, sql));
          yield* sql`UPDATE spaces_asset_reconciliation SET cycle_started_ms = ${meta.observed_time_ms} WHERE singleton = 1 AND cycle_started_ms = 0`;
          const rows = yield* Catalog.recoveryBatch().pipe(
            Effect.provideService(SpacesSql.SpacesSql, sql),
          );
          // One complete hash/publication/cleanup unit fits both startup work budgets.
          for (const row of (ownerAcquired ? rows : []).slice(0, 1)) {
            startupRecoveryGeneration++;
            yield* sql`UPDATE spaces_asset_collection SET last_work_rows=90,last_planned_bytes=${row.expected_bytes * 3} WHERE singleton=1`;
            yield* recover(row, meta.observed_time_ms).pipe(
              Effect.provideService(SpacesSql.SpacesSql, sql),
              Effect.catch(() => Effect.logWarning("Spaces asset recovery remains pending.")),
            );
          }
          yield* Effect.uninterruptible(
            Ref.set(acquiredSql, Option.some(sql)).pipe(
              Effect.andThen(Scope.addFinalizer(scope, Ref.set(acquiredSql, Option.none()))),
            ),
          );
          yield* Scope.addFinalizer(
            scope,
            Effect.uninterruptible(
              Effect.gen(function* () {
                closing = true;
                const self = yield* Effect.fiber;
                yield* Fiber.interruptAll(
                  [...uploadFibers.values()].filter((fiber) => fiber !== self),
                );
                yield* Deferred.await(uploadsIdle);
                yield* maintenanceMutex.withPermits(1)(
                  mutex
                    .withPermits(1)(sql.withTransaction(GC.retireOwner(collectionOwner)))
                    .pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
                );
              }).pipe(
                Effect.catch(() =>
                  Effect.logWarning("Spaces collection owner remains conservatively active."),
                ),
              ),
            ),
          );
          return sql;
        }),
      ),
      Effect.mapError(() => new C.SpacesUnavailableError({ stage: "initializing" })),
      Effect.provide(platform),
    ),
  );
  const admit = Effect.fn("SpacesService.admit")(function* () {
    const snapshot = yield* settings.getSettings.pipe(
      Effect.mapError(() => new C.SpacesUnavailableError({ stage: "settings" })),
    );
    if (!snapshot.spacesEnabled) return yield* new C.SpacesDisabledError();
    // A positive snapshot admits this call; disabling later does not cancel an accepted transaction.
    return yield* identity.getEnvironmentId;
  });
  const checkEnvironment = Effect.fn("SpacesService.checkEnvironment")(function* (
    actual: EnvironmentId,
    requested: EnvironmentId,
  ) {
    if (actual !== requested) {
      const size = byteLength(requested);
      if (size > limits.maxIdBytes)
        return yield* new C.SpaceLimitExceededError({
          limit: "maxIdBytes",
          actual: size,
          maximum: limits.maxIdBytes,
        });
      return yield* new C.SpaceEnvironmentMismatchError({ environmentId: requested });
    }
  });
  const mapStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchTags({
        SqlError: () => Effect.fail(new C.SpacesUnavailableError({ stage: "storage" })),
      }),
      // Only service errors thrown by pure synchronous validators become failures; any other defect is a bug.
      Effect.catchDefect((cause) =>
        isServiceError(cause) ? Effect.fail(cause) : Effect.die(cause),
      ),
    );
  const run = Effect.fn("SpacesService.transaction")(function* <A>(
    environmentId: EnvironmentId,
    use: (
      meta: Receipts.Metadata,
      replay?: C.SpaceMutationReceipt,
    ) => Effect.Effect<A, C.SpaceServiceError | SqlError.SqlError, SpacesSql.SpacesSql>,
    maintenance: true | C.SpaceMutationRequest = true,
  ) {
    const sql = yield* acquire;
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        // Commit the observed clock even when the subsequent request is refused or rolled back.
        const meta = yield* sql.withTransaction(Receipts.observe(environmentId));
        const replay =
          maintenance === true ? undefined : yield* sql.withTransaction(Receipts.find(maintenance));
        if (!replay) {
          if (maintenance === true) yield* sql.withTransaction(Receipts.cleanup(meta));
          yield* sql.withTransaction(RevisionStore.prune(meta.observed_time_ms));
          yield* sql.withTransaction(ReferenceStore.maintain());
          yield* sql.withTransaction(Catalog.expireIdle(meta.observed_time_ms).pipe(assetErrors));
          yield* sql.withTransaction(PageShares.purgeExpired(meta.observed_time_ms));
        }
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const [current] =
              yield* sql<Receipts.Metadata>`SELECT * FROM spaces_core WHERE singleton = 1`;
            if (!current) return yield* new C.SpacesUnavailableError({ stage: "storage" });
            return yield* use(current, replay);
          }),
        );
      }).pipe(Effect.provideService(SpacesSql.SpacesSql, sql), mapStorage),
    );
  });
  // Reads take no mutex and write nothing: one read-only transaction on a WAL reader, with the
  // clock advanced in memory only. Writes own the observed clock and all maintenance.
  const read = Effect.fn("SpacesService.read")(function* <A>(
    environmentId: EnvironmentId,
    use: (
      meta: Receipts.Metadata,
    ) => Effect.Effect<A, C.SpaceServiceError | SqlError.SqlError, SpacesSql.SpacesSql>,
  ) {
    const sql = yield* acquire;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [current] =
            yield* sql<Receipts.Metadata>`SELECT * FROM spaces_core WHERE singleton = 1`;
          if (!current) return yield* new C.SpacesUnavailableError({ stage: "storage" });
          if (current.environment_id !== null && current.environment_id !== environmentId)
            return yield* new C.SpaceEnvironmentMismatchError({ environmentId });
          const now = Math.max(current.observed_time_ms, yield* Clock.currentTimeMillis);
          return yield* use({ ...current, observed_time_ms: now });
        }),
      )
      .pipe(Effect.provideService(SpacesSql.SpacesSql, sql), mapStorage, NodeSqliteClient.readOnly);
  });
  // A read that cannot finish without writing returns `needsWrite` and reruns on the write path.
  const readThenWrite = Effect.fn("SpacesService.readThenWrite")(function* <A>(
    environmentId: EnvironmentId,
    attempt: (
      meta: Receipts.Metadata,
    ) => Effect.Effect<
      { readonly value: A } | typeof needsWrite,
      C.SpaceServiceError | SqlError.SqlError,
      SpacesSql.SpacesSql
    >,
    fallback: (
      meta: Receipts.Metadata,
    ) => Effect.Effect<A, C.SpaceServiceError | SqlError.SqlError, SpacesSql.SpacesSql>,
  ) {
    const result = yield* read(environmentId, attempt);
    return result === needsWrite ? yield* run(environmentId, fallback) : result.value;
  });
  // Lists and pages hand out the active receipt epoch; only the first read of an epoch day must write to mint it.
  const readWithAdmission = <A>(
    environmentId: EnvironmentId,
    use: (
      meta: Receipts.Metadata,
      admission: C.SpaceMutationAdmission,
    ) => Effect.Effect<A, C.SpaceServiceError | SqlError.SqlError, SpacesSql.SpacesSql>,
  ) =>
    readThenWrite(
      environmentId,
      Effect.fnUntraced(function* (meta) {
        const admission = yield* Receipts.peek(meta);
        if (admission === undefined) return needsWrite;
        return { value: yield* use(meta, admission) };
      }),
      (meta) => Effect.flatMap(Receipts.issue(meta), (admission) => use(meta, admission)),
    );
  const leaseUpload = Effect.fn("SpacesService.leaseUpload")(function* (uploadId: string) {
    if (closing || activeUploads.has(uploadId))
      return yield* new C.SpaceAssetError({ reason: "already_claimed" });
    if (activeUploads.size === 0) uploadsIdle = yield* Deferred.make<void>();
    activeUploads.add(uploadId);
    uploadFibers.set(uploadId, yield* Effect.fiber);
    yield* Effect.gen(function* () {
      const current = yield* Ref.get(acquiredSql);
      if (Option.isNone(current)) return;
      const sql = current.value;
      yield* mutex.withPermits(1)(
        sql.withTransaction(
          GC.uploadActivity(collectionOwner, uploadId, null).pipe(
            Effect.provideService(SpacesSql.SpacesSql, sql),
          ),
        ),
      );
    }).pipe(
      assetErrors,
      Effect.onError(() =>
        Effect.gen(function* () {
          activeUploads.delete(uploadId);
          uploadFibers.delete(uploadId);
          if (activeUploads.size === 0) yield* Deferred.succeed(uploadsIdle, undefined);
        }),
      ),
    );
  }, Effect.uninterruptible);
  const releaseUpload = Effect.fn("SpacesService.releaseUpload")(function* (uploadId: string) {
    yield* Effect.gen(function* () {
      const current = yield* Ref.get(acquiredSql);
      if (Option.isNone(current)) return;
      const environmentId = yield* identity.getEnvironmentId;
      const sql = current.value;
      yield* mutex.withPermits(1)(
        sql
          .withTransaction(
            Effect.gen(function* () {
              const meta = yield* Receipts.observe(environmentId);
              yield* GC.uploadActivity(collectionOwner, uploadId, meta.observed_time_ms);
            }),
          )
          .pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
      );
    }).pipe(Effect.catch(() => Effect.logWarning("Spaces upload quiescence remains unconfirmed.")));
    activeUploads.delete(uploadId);
    uploadFibers.delete(uploadId);
    if (activeUploads.size === 0) yield* Deferred.succeed(uploadsIdle, undefined);
  }, Effect.uninterruptible);
  return {
    dbPath,
    settings,
    identity,
    platform,
    mutex,
    acquiredSql,
    fs,
    path,
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
    read,
    readThenWrite,
    readWithAdmission,
    leaseUpload,
    releaseUpload,
    startupRecoveryGeneration: () => startupRecoveryGeneration,
  };
});
export type Runtime = Effect.Success<ReturnType<typeof make>>;
