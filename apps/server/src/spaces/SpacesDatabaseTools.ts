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

export class SpacesDatabaseTools extends Context.Service<
  SpacesDatabaseTools,
  {
    readonly inspect: (databasePath: string) => Effect.Effect<
      {
        readonly databaseBytes: number;
        readonly walBytes: number;
        readonly sharedMemoryBytes: number;
        readonly reclaimableBytes: number;
      } | null,
      SpacesDatabaseInspectError
    >;
    readonly initializeIfMissing: (
      databasePath: string,
    ) => Effect.Effect<void, SpacesDatabaseInspectError | SpacesDatabaseInitializeError>;
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
      const reclaimableBytes = yield* Effect.gen(function* () {
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
            return (free?.freelist_count ?? 0) * (size?.page_size ?? 0);
          }),
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })));
      const bytes = yield* Effect.all({
        databaseBytes: fileBytes(databasePath),
        walBytes: fileBytes(`${databasePath}-wal`),
        sharedMemoryBytes: fileBytes(`${databasePath}-shm`),
      });
      return { ...bytes, reclaimableBytes };
    },
    (effect, databasePath) =>
      effect.pipe(
        Effect.mapError((cause) => new SpacesDatabaseInspectError({ path: databasePath, cause })),
      ),
  );
  const initializeIfMissing = Effect.fn("SpacesDatabaseTools.initializeIfMissing")(function* (
    databasePath: string,
  ) {
    if ((yield* inspect(databasePath)) !== null) return;
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
      // Publish a closed, checkpointed database without replacing a concurrent creator's file.
      yield* fs.link(temporaryPath, databasePath).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          (cause) =>
            inspect(databasePath).pipe(
              Effect.flatMap((status) =>
                status === null
                  ? Effect.fail(new SpacesDatabaseInitializeError({ path: databasePath, cause }))
                  : Effect.void,
              ),
            ),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        cause._tag === "SpacesDatabaseInspectError" ||
        cause._tag === "SpacesDatabaseInitializeError"
          ? cause
          : new SpacesDatabaseInitializeError({ path: databasePath, cause }),
      ),
    );
  });
  return SpacesDatabaseTools.of({ inspect, initializeIfMissing });
});

export const layer = Layer.effect(SpacesDatabaseTools, make);
