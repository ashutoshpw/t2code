// @effect-diagnostics nodeBuiltinImport:off -- subprocess fixture retains real committed SQLite sidecars.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as SpacesDatabaseTools from "./SpacesDatabaseTools.ts";
import * as SpacesSql from "./SpacesSql.ts";
import * as Sqlite from "./Sqlite.ts";

it.effect.each(["wal", "shm", "both"] as const)(
  "refuses initialization with orphaned %s sidecars without changing them",
  (retained) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tools = yield* SpacesDatabaseTools.SpacesDatabaseTools;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-orphan-sidecars-" });
      const dbPath = path.join(directory, "spaces.sqlite");
      yield* SpacesSql.SpacesSql.pipe(Effect.provide(Sqlite.layerFromPath(dbPath)));
      const writer = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import { DatabaseSync } from 'node:sqlite';
            const db = new DatabaseSync(process.argv[1]);
            db.exec("PRAGMA wal_autocheckpoint = 0; UPDATE spaces SET title = 'ORPHAN WAL DATA', revision = 7 WHERE is_default = 1");
            process.exit(0);
          `,
          dbPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(writer.status, 0, writer.stderr);
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      const wal = yield* fs.readFile(walPath);
      const shm = yield* fs.readFile(shmPath);
      assert.isAbove(wal.length, 32);
      assert.isAbove(shm.length, 0);
      yield* fs.remove(dbPath);
      if (retained === "wal") yield* fs.remove(shmPath);
      if (retained === "shm") yield* fs.remove(walPath);

      const result = yield* tools.initializeIfMissing(dbPath).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result), "Initializer accepted orphaned SQLite sidecars");
      if (Result.isFailure(result))
        assert.equal(result.failure._tag, "SpacesDatabaseOrphanSidecarsError");
      assert.isFalse(yield* fs.exists(dbPath));
      if (retained !== "shm") assert.equal(Buffer.compare(yield* fs.readFile(walPath), wal), 0);
      if (retained !== "wal") assert.equal(Buffer.compare(yield* fs.readFile(shmPath), shm), 0);
      assert.deepEqual(
        (yield* fs.readDirectory(directory)).sort(),
        retained === "both"
          ? ["spaces.sqlite-shm", "spaces.sqlite-wal"]
          : [`spaces.sqlite-${retained}`],
      );
    }).pipe(Effect.provide(SpacesDatabaseTools.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

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

it.effect("completes competing initializations with one valid default space", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tools = yield* SpacesDatabaseTools.SpacesDatabaseTools;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-competing-init-" });
    const dbPath = path.join(directory, "spaces.sqlite");
    yield* Effect.all([tools.initializeIfMissing(dbPath), tools.initializeIfMissing(dbPath)], {
      concurrency: "unbounded",
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* sql`SELECT title, is_default, revision FROM spaces`, [
        { title: "My space", is_default: 1, revision: 0 },
      ]);
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
        [
          { migration_id: 1, name: "Spaces" },
          { migration_id: 2, name: "Core" },
          { migration_id: 3, name: "RevisionPreimages" },
          { migration_id: 4, name: "PageOwners" },
          { migration_id: 5, name: "ReferenceIdentity" },
          { migration_id: 6, name: "Recovery" },
          { migration_id: 7, name: "Search" },
          { migration_id: 8, name: "Assets" },
          { migration_id: 9, name: "AssetReconciliation" },
          { migration_id: 10, name: "AssetCollection" },
          { migration_id: 11, name: "PageActivity" },
          { migration_id: 12, name: "PageLibrary" },
          { migration_id: 13, name: "LibraryRevisions" },
          { migration_id: 14, name: "PageShares" },
          { migration_id: 15, name: "PageIcon" },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
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
