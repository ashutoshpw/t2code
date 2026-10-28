import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { assertSpacesDatabase, runMigrations } from "./Migrations.ts";
import * as SpacesSql from "./SpacesSql.ts";

const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

const layerSetup = Layer.effect(
  SpacesSql.SpacesSql,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.gen(function* () {
      yield* assertSpacesDatabase();
      yield* sql`PRAGMA busy_timeout = 5000`;
      yield* sql`PRAGMA foreign_keys = ON`;
      const [tables] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'
      `;
      if (tables?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`PRAGMA synchronous = NORMAL`;
      yield* sql`PRAGMA checkpoint_fullfsync = ON`;
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
      yield* runMigrations();
    }).pipe(Effect.provideService(SpacesSql.SpacesSql, sql));
    return sql;
  }),
);

// Acquire only after the service's enabled gate; disabled startup never opens this database.
export const layerFromPath = Effect.fn("SpacesSqlite.layerFromPath")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  yield* fs.writeFile(dbPath, new Uint8Array(), { flag: "wx" }).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "AlreadyExists",
      () => Effect.void,
    ),
  );
  // Closing even an unused writer can checkpoint foreign WAL; validate without a writer first.
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* assertSpacesDatabase().pipe(Effect.provideService(SpacesSql.SpacesSql, sql));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
  return layerSetup.pipe(
    Layer.provide(
      NodeSqliteClient.layer({
        filename: dbPath,
        readerWorker: true,
        checkpointWorker: true,
        spanAttributes: { "db.name": path.basename(dbPath), "service.name": "t2code-server" },
      }),
    ),
  );
}, Layer.unwrap);

export const layerMemory = layerSetup.pipe(
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);
