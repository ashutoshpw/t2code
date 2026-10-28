import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { assertSpacesDatabase, SpacesDatabaseMismatchError } from "./Migrations.ts";
import * as SpacesSql from "./SpacesSql.ts";
import * as Sqlite from "./Sqlite.ts";
import * as Reconciliation from "./assets/Reconciliation.ts";
import type { SpacesStorageStatus } from "@t2code/contracts";

export class SpacesDatabaseInspectError extends Schema.TaggedError<SpacesDatabaseInspectError>()(
  "SpacesDatabaseInspectError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not inspect the Spaces database.";
  }
}

export class SpacesDatabaseInitializeError extends Schema.TaggedError<SpacesDatabaseInitializeError>()(
  "SpacesDatabaseInitializeError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not initialize the isolated Spaces database.";
  }
}

export class SpacesDatabaseOrphanSidecarsError extends Schema.TaggedError<SpacesDatabaseOrphanSidecarsError>()(
  "SpacesDatabaseOrphanSidecarsError",
  { path: Schema.String },
) {
  override get message() {
    return "Refusing to initialize Spaces while orphaned SQLite sidecars remain.";
  }
}

export class SpacesDatabaseTools extends Context.Service<
  SpacesDatabaseTools,
  {
    readonly inspect: (databasePath: string) => Effect.Effect<
      {
        readonly databaseBytes: number;
        readonly walBytes: number;
        readonly sharedMemoryBytes: number;
        readonly reclaimableBytes: number;
        readonly assetAccounting: Omit<
          SpacesStorageStatus,
          "databaseBytes" | "walBytes" | "sharedMemoryBytes"
        > | null;
      } | null,
      SpacesDatabaseInspectError
    >;
    readonly initializeIfMissing: (
      databasePath: string,
    ) => Effect.Effect<
      void,
      SpacesDatabaseInspectError | SpacesDatabaseInitializeError | SpacesDatabaseOrphanSidecarsError
    >;
  }
>()("@t2code/cli/spaces/SpacesDatabaseTools") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fileBytes = Effect.fn("SpacesDatabaseTools.fileBytes")((file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(0),
      ),
    ),
  );
  const inspect = Effect.fn("SpacesDatabaseTools.inspect")(
    function* (databasePath: string) {
      if (!(yield* fs.exists(databasePath))) return null;
      const inspected = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* assertSpacesDatabase().pipe(Effect.provideService(SpacesSql.SpacesSql, sql));
            const defaults = yield* sql`SELECT 1 FROM spaces WHERE is_default = 1 LIMIT 2`;
            if (defaults.length !== 1) {
              return yield* new SpacesDatabaseMismatchError({ reason: "migration-history" });
            }
            const [free] = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
            const [size] = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
            const available =
              yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'spaces_asset_reconciliation'`;
            const assetAccounting = available.length
              ? yield* Effect.gen(function* () {
                  const [usage] = yield* sql<{
                    readonly physical_bytes: number;
                    readonly reserved_bytes: number;
                  }>`SELECT physical_bytes,reserved_bytes FROM spaces_asset_usage WHERE singleton = 1`;
                  const current = yield* Reconciliation.state();
                  return {
                    registeredAssetBytes: usage!.physical_bytes,
                    reservedBytes: usage!.reserved_bytes,
                    observedAssetFileBytes: current.assets_bytes,
                    observedStagingFileBytes: current.staging_bytes,
                    observedAt: current.observed_at_ms,
                    reconciliation: yield* Reconciliation.status(),
                  };
                }).pipe(Effect.provideService(SpacesSql.SpacesSql, sql))
              : null;
            return {
              reclaimableBytes: (free?.freelist_count ?? 0) * (size?.page_size ?? 0),
              assetAccounting,
            };
          }),
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })));
      const bytes = yield* Effect.all({
        databaseBytes: fileBytes(databasePath),
        walBytes: fileBytes(`${databasePath}-wal`),
        sharedMemoryBytes: fileBytes(`${databasePath}-shm`),
      });
      return { ...bytes, ...inspected };
    },
    (effect, databasePath) =>
      effect.pipe(
        Effect.mapError((cause) => new SpacesDatabaseInspectError({ path: databasePath, cause })),
      ),
  );
  const hasEntry = Effect.fn("SpacesDatabaseTools.hasEntry")(
    function* (file: string) {
      if (yield* fs.exists(file)) return true;
      return yield* fs.readLink(file).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(false),
        ),
      );
    },
    (effect, file) =>
      effect.pipe(
        Effect.mapError((cause) => new SpacesDatabaseInitializeError({ path: file, cause })),
      ),
  );
  const initializationTargetReady = Effect.fn("SpacesDatabaseTools.initializationTargetReady")(
    function* (databasePath: string) {
      if ((yield* inspect(databasePath)) !== null) return true;
      for (const suffix of ["-wal", "-shm"]) {
        if (yield* hasEntry(`${databasePath}${suffix}`)) {
          if ((yield* inspect(databasePath)) !== null) return true;
          return yield* new SpacesDatabaseOrphanSidecarsError({ path: databasePath });
        }
      }
      return false;
    },
  );
  const initializeIfMissing = Effect.fn("SpacesDatabaseTools.initializeIfMissing")(function* (
    databasePath: string,
  ) {
    if (yield* initializationTargetReady(databasePath)) return;
    yield* Effect.gen(function* () {
      const directory = path.dirname(databasePath);
      yield* fs.makeDirectory(directory, { recursive: true });
      const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
        directory,
        prefix: ".spaces-init-",
      });
      const temporaryPath = path.join(temporaryDirectory, "spaces.sqlite");
      yield* SpacesSql.SpacesSql.pipe(
        Effect.provide(Sqlite.layerFromPath(temporaryPath)),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      yield* fs.chmod(temporaryPath, 0o600);
      if (yield* initializationTargetReady(databasePath)) return;
      // Publish a closed, checkpointed database without replacing a concurrent creator's file.
      yield* fs.link(temporaryPath, databasePath).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          (cause) =>
            initializationTargetReady(databasePath).pipe(
              Effect.flatMap((ready) =>
                ready
                  ? Effect.void
                  : Effect.fail(new SpacesDatabaseInitializeError({ path: databasePath, cause })),
              ),
            ),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        cause._tag === "SpacesDatabaseInspectError" ||
        cause._tag === "SpacesDatabaseInitializeError" ||
        cause._tag === "SpacesDatabaseOrphanSidecarsError"
          ? cause
          : new SpacesDatabaseInitializeError({ path: databasePath, cause }),
      ),
    );
  });
  return SpacesDatabaseTools.of({ inspect, initializeIfMissing });
});

export const layer = Layer.effect(SpacesDatabaseTools, make);
