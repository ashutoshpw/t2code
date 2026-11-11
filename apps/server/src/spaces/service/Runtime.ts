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
import { byteLength, computedDrainRows, databaseSweepIntervalMs, limits } from "../CorePolicy.ts";
import * as Changes from "../databases/Changes.ts";
import * as DatabaseStore from "../databases/DatabaseStore.ts";
import * as Drain from "../databases/computed/Drain.ts";
import { isoNow } from "../databases/Types.ts";
import * as Receipts from "../Receipts.ts";
import * as RevisionStore from "../RevisionStore.ts";
import * as PageShares from "../PageShares.ts";
import * as ReferenceStore from "../ReferenceStore.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as SearchStore from "../SearchStore.ts";
import * as Sqlite from "../Sqlite.ts";
import * as DatabaseSweep from "./DatabaseSweep.ts";
import { assetErrors, claimFrom, isServiceError, needsWrite } from "./Helpers.ts";

export interface RuntimeOptions {
  /** Computes queued formula and rollup values in the background (default). Tests turn it off. */
  readonly backgroundDrain?: boolean;
  /** Removes dead databases and orphan views once their retention has passed (default). Tests turn it off. */
  readonly backgroundSweep?: boolean;
}

export const make = Effect.fnUntraced(function* (
  dbPath: string,
  directories?: { readonly assetsDir: string; readonly stagingDir: string },
  options?: RuntimeOptions,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const scope = yield* Effect.scope;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const mutex = yield* Semaphore.make(1);
  const changes = Changes.makeHub();
  const acquiredSql = yield* Ref.make(Option.none<SpacesSql.SpacesSql["Service"]>());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const assetDirectories = directories ?? {
    assetsDir: path.join(path.dirname(dbPath), "spaces", "assets"),
    stagingDir: path.join(path.dirname(dbPath), "spaces", "staging"),
  };
  const backgroundDrain = options?.backgroundDrain !== false;
  const backgroundSweep = options?.backgroundSweep !== false;
  let draining = false;
  let sweeping = false;
  let lastSweepMs: number | undefined;
  const skippedRows = new Set<string>();
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
  // Declared before `acquire` so its first run can start the drain; filled in below.
  const background: { start: (sql: SpacesSql.SpacesSql["Service"]) => Effect.Effect<void> } = {
    start: () => Effect.void,
  };
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
          yield* background.start(sql);
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
  // Records the revisions a write changes, reads them in the same transaction, and hands them to
  // subscribers only after it commits. A rolled-back transaction publishes nothing. Call under the mutex.
  const publishing = Effect.fn("SpacesService.publishing")(function* <A, E, R>(
    sql: SpacesSql.SpacesSql["Service"],
    body: Effect.Effect<A, E, R>,
  ) {
    const collector = Changes.makeCollector();
    const [value, batch] = yield* sql.withTransaction(
      Effect.gen(function* () {
        const result = yield* body.pipe(
          Effect.provideService(Changes.CurrentChangeCollector, collector),
        );
        return [result, yield* Changes.resolve(collector)] as const;
      }),
    );
    yield* changes.publish(batch);
    return value;
  });
  const run = Effect.fn("SpacesService.transaction")(function* <A>(
    environmentId: EnvironmentId,
    use: (
      meta: Receipts.Metadata,
      replay?: C.SpaceMutationReceipt,
    ) => Effect.Effect<A, C.SpaceServiceError | SqlError.SqlError, SpacesSql.SpacesSql>,
    maintenance: true | C.SpaceMutationRequest = true,
  ) {
    const sql = yield* acquire;
    const result = yield* mutex.withPermits(1)(
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
        return yield* publishing(
          sql,
          Effect.gen(function* () {
            const [current] =
              yield* sql<Receipts.Metadata>`SELECT * FROM spaces_core WHERE singleton = 1`;
            if (!current) return yield* new C.SpacesUnavailableError({ stage: "storage" });
            return yield* use(current, replay);
          }),
        );
      }).pipe(Effect.provideService(SpacesSql.SpacesSql, sql), mapStorage),
    );
    yield* background.start(sql);
    return result;
  });
  // Computed values that did not fit in a mutation are brought up to date here, in bounded
  // transactions that yield the write mutex between batches.
  const drainComputed = Effect.fn("SpacesService.drainComputed")(function* () {
    const sql = yield* acquire;
    for (;;) {
      const more = yield* mutex
        .withPermits(1)(
          publishing(
            sql,
            Effect.gen(function* () {
              const result = yield* Drain.batch({ limit: computedDrainRows, order: "ASC" });
              if (result.changed.size > 0) {
                const now = yield* Clock.currentTimeMillis;
                for (const id of result.changed) yield* DatabaseStore.bumpData(id, isoNow(now));
              }
              return result.processed > 0 && (yield* Drain.queued());
            }),
          ),
        )
        .pipe(Effect.provideService(SpacesSql.SpacesSql, sql), mapStorage);
      if (!more) return;
      yield* Effect.yieldNow;
    }
  });
  // A defect or an interruption must not leave the flag set, or the drain would never restart.
  const startDrain = (sql: SpacesSql.SpacesSql["Service"]): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!backgroundDrain || draining || closing) return Effect.void;
      return Drain.queued().pipe(
        Effect.provideService(SpacesSql.SpacesSql, sql),
        Effect.orElseSucceed(() => false),
        Effect.flatMap((queued) => {
          if (!queued) return Effect.void;
          draining = true;
          return Effect.forkIn(
            drainComputed().pipe(
              Effect.tapError(() => Effect.logWarning("Spaces computed values remain queued.")),
              Effect.ensuring(Effect.sync(() => void (draining = false))),
              Effect.andThen(Effect.suspend(() => startDrain(sql))),
              Effect.ignore,
            ),
            scope,
          ).pipe(Effect.asVoid);
        }),
      );
    });
  // One pass: survey on the read path, then re-check and write in one maintenance transaction.
  // `between` lets a test change the database between the two halves.
  const sweepDatabases = Effect.fn("SpacesService.sweepDatabases")(function* (
    between?: Effect.Effect<void, C.SpaceServiceError>,
  ) {
    const environmentId = yield* identity.getEnvironmentId;
    const found = yield* read(environmentId, (meta) =>
      DatabaseSweep.survey(meta.observed_time_ms, skippedRows),
    );
    if (between !== undefined) yield* between;
    if (DatabaseSweep.idle(found)) return false;
    return yield* run(environmentId, (meta) =>
      DatabaseSweep.write(found, environmentId, meta.observed_time_ms, skippedRows),
    );
  });
  // Rides on write activity, at most once per interval; no timer. A purge that made progress
  // continues in further bounded passes, each its own transaction.
  const startSweep = Effect.suspend(() => {
    if (!backgroundSweep || sweeping || closing) return Effect.void;
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => {
        if (lastSweepMs !== undefined && now - lastSweepMs < databaseSweepIntervalMs)
          return Effect.void;
        sweeping = true;
        lastSweepMs = now;
        return Effect.forkIn(
          Effect.gen(function* () {
            while (yield* sweepDatabases()) yield* Effect.yieldNow;
          }).pipe(
            Effect.tapError(() =>
              Effect.logWarning("Spaces dead-database cleanup remains pending."),
            ),
            Effect.ensuring(Effect.sync(() => void (sweeping = false))),
            Effect.ignore,
          ),
          scope,
        ).pipe(Effect.asVoid);
      }),
    );
  });
  background.start = (sql) => Effect.andThen(startDrain(sql), startSweep);
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
    changes,
    drainComputed,
    sweepDatabases,
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
