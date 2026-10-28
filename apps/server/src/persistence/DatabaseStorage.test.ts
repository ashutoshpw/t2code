import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { EnvironmentId } from "@t2code/contracts";
import * as SpacesService from "../spaces/SpacesService.ts";
import * as Settings from "../serverSettings.ts";
import * as Identity from "../environment/ServerEnvironment.ts";

import * as ServerConfig from "../config.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import * as DatabaseStorage from "./DatabaseStorage.ts";
import * as Sqlite from "./Sqlite.ts";

const freePages = Effect.map(
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`,
  ),
  (rows) => rows[0]?.freelist_count ?? 0,
);

const storageLayer = <E>(
  config: Layer.Layer<ServerConfig.ServerConfig, E, FileSystem.FileSystem | Path.Path>,
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(config),
    Layer.provide(NodeServices.layer),
  );

const testConfig = ServerConfig.layerTest(process.cwd(), { prefix: "database-storage-" });

it.effect("publishes bounded Spaces accounting through the existing storage status worker", () =>
  Effect.gen(function* () {
    const storage = yield* DatabaseStorage.DatabaseStorage;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const result = yield* Stream.runHead(
      storage.status.pipe(Stream.filter((status) => status !== null)),
    );
    const status = Option.getOrThrow(result)!;
    assert.isNotNull(status.spaces);
    assert.isDefined(status.spaces);
    assert.equal(status.spaces?.databaseBytes, Number((yield* fs.stat(config.spacesDbPath)).size));
    assert.deepEqual(status.spaces?.reconciliation, {
      currentPending: false,
      historyPending: true,
      catalogPending: true,
      inventoryPending: true,
      unresolved: false,
      gcEnabled: false,
      gcPending: true,
    });
  }).pipe(
    Effect.provide(
      DatabaseStorage.layer.pipe(
        Layer.provide(
          Layer.unwrap(
            Effect.map(ServerConfig.ServerConfig, (config) =>
              SpacesService.layerFromPath(config.spacesDbPath),
            ),
          ).pipe(
            Layer.provide(Settings.layerTest({ spacesEnabled: true })),
            Layer.provide(
              Layer.succeed(Identity.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make("storage-report")),
              }),
            ),
          ),
        ),
        Layer.provide(ProjectionMaintenance.layer),
        Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provideMerge(testConfig),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("a new database returns freed pages online without losing data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* DatabaseStorage.DatabaseStorage;
    assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
    yield* sql`CREATE TABLE retained (value TEXT)`;
    yield* sql`INSERT INTO retained VALUES ('keep')`;
    yield* sql`CREATE TABLE discarded (value BLOB)`;
    yield* sql`INSERT INTO discarded VALUES (zeroblob(1048576))`;
    yield* sql`DROP TABLE discarded`;
    assert.isAbove(yield* freePages, 0);
    yield* storage.reclaim;
    assert.equal(yield* freePages, 0);
    assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "keep" }]);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);

const compactionLayer = (
  pruneEventStore: ProjectionMaintenance.ProjectionMaintenanceV2["Service"]["pruneEventStore"],
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(
      Layer.succeed(ProjectionMaintenance.ProjectionMaintenanceV2, {
        pruneEventStore,
      }),
    ),
    Layer.provide(Sqlite.layerMemory),
  );

const minute = 60_000;
const startupTime = Date.UTC(2026, 9, 19);
const emptyCompaction = { deletedEventCount: 0, deletedReceiptCount: 0, reclaimableBytes: 0 };

it.effect("remembers completion only after the paced pass finishes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startupTime);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const timestampPath = path.join(path.dirname(config.dbPath), "compacted-at");
    const betweenPagesReached = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const timestampWritten = yield* Deferred.make<void>();
    const compact = (betweenPages: Effect.Effect<void> = Effect.void) =>
      Effect.gen(function* () {
        yield* Effect.sleep(30);
        yield* Deferred.succeed(betweenPagesReached, undefined);
        yield* betweenPages;
        yield* Deferred.succeed(completed, undefined);
        return emptyCompaction;
      });
    yield* Effect.gen(function* () {
      yield* TestClock.adjust(minute);
      yield* TestClock.adjust(30);
      yield* Deferred.await(betweenPagesReached);
      assert.isFalse(yield* Deferred.isDone(completed));
      assert.isFalse(yield* fs.exists(timestampPath));
      yield* TestClock.adjust(269);
      assert.isFalse(yield* Deferred.isDone(completed));
      assert.isFalse(yield* fs.exists(timestampPath));
      yield* TestClock.adjust(1);
      yield* Deferred.await(timestampWritten);
      assert.isTrue(yield* Deferred.isDone(completed));
      assert.equal(Number(yield* fs.readFileString(timestampPath)), startupTime + minute + 300);
    }).pipe(
      Effect.provide(compactionLayer(compact)),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: (file, content, options) =>
          fs
            .writeFileString(file, content, options)
            .pipe(Effect.ensuring(Deferred.succeed(timestampWritten, undefined))),
      }),
    );
  }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

// NONE is a database from before automatic shrinking, which the repair converts.
const reclaimLayer = (
  restart: Effect.Effect<void> | null,
  autoVacuum: "NONE" | "FULL" | "INCREMENTAL" = "NONE",
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provide(Layer.succeed(DatabaseStorage.ServerRestart, restart)),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`PRAGMA auto_vacuum = ${autoVacuum}`);
          yield* sql`VACUUM`;
        }),
      ).pipe(Layer.provideMerge(Sqlite.layerMemory)),
    ),
  );

it.effect(
  "a reclaim from Settings saves its request, then restarts the server after replying",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const files = DatabaseMaintenance.reclaimFiles(path, config.dbPath);
      const request = Effect.flatMap(
        DatabaseStorage.DatabaseStorage,
        (storage) => storage.requestReclaim,
      );
      const restarted = yield* Deferred.make<void>();
      const restart = Deferred.succeed(restarted, undefined).pipe(Effect.asVoid);

      // Nothing starts a server run by hand again, so it keeps pointing at the command.
      const unsupervised = yield* request.pipe(Effect.flip, Effect.provide(reclaimLayer(null)));
      assert.equal(unsupervised._tag, "DatabaseReclaimError");
      // A database that already shrinks on its own (or a stale dialog after another client's
      // repair) has nothing to reclaim, so it must not restart.
      for (const autoVacuum of ["FULL", "INCREMENTAL"] as const) {
        const refused = yield* request.pipe(
          Effect.flip,
          Effect.provide(reclaimLayer(restart, autoVacuum)),
        );
        assert.equal(refused._tag, "DatabaseReclaimError", autoVacuum);
      }
      assert.isFalse(yield* fs.exists(files.request));

      yield* fs.writeFileString(files.failure, "an earlier failure");
      yield* Effect.gen(function* () {
        const storage = yield* DatabaseStorage.DatabaseStorage;
        const shownFailure = storage.status.pipe(
          Stream.filter((status) => status !== null),
          Stream.runHead,
          Effect.map((status) => Option.getOrThrow(status)?.reclaimFailure),
        );
        assert.equal(yield* shownFailure, "an earlier failure");
        yield* storage.requestReclaim;
        // The retry clears it at once, so Settings shows the restart, not the old failure.
        assert.isUndefined(yield* shownFailure);
      }).pipe(Effect.provide(reclaimLayer(restart)));
      assert.isTrue(yield* fs.exists(files.request));
      assert.isFalse(yield* fs.exists(files.failure));
      assert.isFalse(yield* Deferred.isDone(restarted), "the reply must go out before the restart");
      yield* TestClock.adjust(500);
      yield* Deferred.await(restarted);
    }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect.each(["valid", "foreign", "busy"] as const)(
  "keeps the existing minute reclaim/status opportunity independent with %s Spaces and nonincremental chat",
  (mode) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(config.dbPath), { recursive: true });
      yield* fs.writeFileString(path.join(path.dirname(config.dbPath), "compacted-at"), "0");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE keep_chat(value TEXT)`;
        yield* sql`INSERT INTO keep_chat VALUES ('keep')`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.dbPath })), Effect.scoped);
      if (mode === "foreign")
        yield* fs.writeFileString(config.spacesDbPath, "foreign Spaces bytes");
      const system = DatabaseStorage.layer.pipe(
        Layer.provideMerge(
          SpacesService.layerFromPath(config.spacesDbPath).pipe(
            Layer.provide(Settings.layerTest({ spacesEnabled: true })),
            Layer.provide(
              Layer.succeed(Identity.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make("reclaim-opportunity")),
              }),
            ),
          ),
        ),
        Layer.provide(ProjectionMaintenance.layer),
        Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
        Layer.provideMerge(Sqlite.layerFromPath(config.dbPath)),
      );
      yield* Effect.gen(function* () {
        const storage = yield* DatabaseStorage.DatabaseStorage;
        const spaces = yield* SpacesService.SpacesService;
        const chat = yield* SqlClient.SqlClient;
        const first = Option.getOrThrow(
          yield* Stream.runHead(storage.status.pipe(Stream.filter((status) => status !== null))),
        )!;
        assert.isFalse(first.incrementalVacuumEnabled);
        assert.deepEqual(yield* chat`PRAGMA auto_vacuum`, [{ auto_vacuum: 0 }]);
        if (mode !== "foreign")
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE reclaim_churn(value BLOB)`;
            yield* sql`INSERT INTO reclaim_churn VALUES (zeroblob(1048576))`;
            yield* sql`DROP TABLE reclaim_churn`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        const free = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return (yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`)[0]!
            .freelist_count;
        }).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath, readonly: true })),
        );
        const initialFree = mode === "foreign" ? 0 : yield* free;
        if (mode !== "foreign") assert.isAbove(initialFree, 128);
        yield* Effect.scoped(
          Effect.gen(function* () {
            if (mode === "busy") {
              const context = yield* Layer.buildWithScope(
                NodeSqliteClient.layer({ filename: config.spacesDbPath }),
                yield* Effect.scope,
              );
              const lock = Context.get(context, SqlClient.SqlClient);
              yield* Effect.acquireRelease(lock`BEGIN IMMEDIATE`, () =>
                lock`ROLLBACK`.pipe(Effect.ignore),
              );
            }
            yield* storage.reclaim;
            if (mode === "valid") assert.equal(initialFree - (yield* free), 64);
            if (mode === "busy") assert.equal(yield* free, initialFree);
            yield* chat`INSERT INTO keep_chat VALUES (zeroblob(262144))`;
            yield* TestClock.adjust("1 minute");
            const next = Option.getOrThrow(
              yield* Stream.runHead(
                storage.status.pipe(
                  Stream.filter(
                    (status) => status !== null && status.databaseBytes > first.databaseBytes,
                  ),
                ),
              ),
            )!;
            assert.isFalse(next.incrementalVacuumEnabled);
            assert.deepEqual(yield* chat`SELECT value FROM keep_chat WHERE value='keep'`, [
              { value: "keep" },
            ]);
            assert.equal(
              yield* fs.readFileString(path.join(path.dirname(config.dbPath), "compacted-at")),
              "0",
            );
            if (mode === "valid") {
              assert.isTrue(next.spaces?.incrementalVacuumEnabled);
              assert.isAbove(next.spaces?.reclaimableBytes ?? 0, 0);
              assert.isBelow(yield* free, initialFree - 64);
              assert.isFalse(next.spaces?.reconciliation.gcEnabled);
            } else assert.isNull(next.spaces);
          }),
        );
        if (mode === "busy") {
          yield* storage.reclaim;
          assert.equal(initialFree - (yield* free), 64);
          assert.isTrue((yield* spaces.maintainAssets)?.incrementalVacuumEnabled);
        }
        if (mode === "foreign")
          assert.equal(yield* fs.readFileString(config.spacesDbPath), "foreign Spaces bytes");
      }).pipe(Effect.provide(system));
    }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);
    }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);
