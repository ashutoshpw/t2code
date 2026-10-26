import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SpacesDatabaseTools from "./SpacesDatabaseTools.ts";
import * as SpacesSql from "./SpacesSql.ts";
import * as Sqlite from "./Sqlite.ts";

it.effect("refuses an uninitialized existing file without replacing or migrating it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tools = yield* SpacesDatabaseTools.SpacesDatabaseTools;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-existing-empty-" });
    const dbPath = path.join(directory, "spaces.sqlite");
    yield* fs.writeFileString(dbPath, "");
    const failure = yield* tools.initializeIfMissing(dbPath).pipe(Effect.flip);
    assert.equal(failure._tag, "SpacesDatabaseInspectError");
    assert.equal(Number((yield* fs.stat(dbPath)).size), 0);
    assert.deepEqual(yield* fs.readDirectory(directory), ["spaces.sqlite"]);
  }).pipe(Effect.provide(SpacesDatabaseTools.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("inspects Spaces storage and free pages without checkpointing committed WAL", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tools = yield* SpacesDatabaseTools.SpacesDatabaseTools;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-storage-inspect-" });
    const dbPath = path.join(directory, "spaces.sqlite");
    yield* SpacesSql.SpacesSql.pipe(Effect.provide(Sqlite.layerFromPath(dbPath)));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA wal_autocheckpoint = 0`;
      yield* sql`CREATE TABLE discarded (value BLOB)`;
      yield* sql`INSERT INTO discarded VALUES (zeroblob(131072))`;
      yield* sql`DROP TABLE discarded`;
      const main = yield* fs.readFile(dbPath);
      const wal = yield* fs.readFile(`${dbPath}-wal`);
      const shm = yield* fs.stat(`${dbPath}-shm`);
      const status = yield* tools.inspect(dbPath);
      assert.isNotNull(status);
      assert.equal(status?.databaseBytes, main.length);
      assert.equal(status?.walBytes, wal.length);
      assert.equal(status?.sharedMemoryBytes, Number(shm.size));
      assert.isAbove(status?.reclaimableBytes ?? 0, 0);
      assert.equal(Buffer.compare(yield* fs.readFile(dbPath), main), 0);
      assert.equal(Buffer.compare(yield* fs.readFile(`${dbPath}-wal`), wal), 0);
      assert.equal((yield* sql`SELECT title FROM spaces`)[0]?.title, "My space");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
  }).pipe(Effect.provide(SpacesDatabaseTools.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
