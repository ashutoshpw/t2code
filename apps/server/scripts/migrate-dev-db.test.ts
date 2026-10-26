// @effect-diagnostics nodeBuiltinImport:off -- subprocess fixture retains committed Spaces WAL.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../src/persistence/Migrations.ts";
import * as SpacesDatabaseTools from "../src/spaces/SpacesDatabaseTools.ts";
import * as SpacesSql from "../src/spaces/SpacesSql.ts";
import * as SpacesSqlite from "../src/spaces/Sqlite.ts";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import { runMigrateDevDb } from "./migrate-dev-db.ts";

const withDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const createFixtureSource = Effect.fn("createMigrateDevDbFixtureSource")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-kept', 'Kept', '/tmp/kept', '[]', '2026-08-01', '2026-08-01', NULL),
        ('project-deleted', 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;

      const forkPayload =
        '{"lineage":{"parentThreadId":"stopped-thread","relationshipToParent":"fork","rootThreadId":"stopped-thread"}}';
      const subagentPayload =
        '{"lineage":{"parentThreadId":"subagent-parent","relationshipToParent":"subagent","rootThreadId":"subagent-parent"},"forkedFrom":{"type":"node","nodeId":"node-1"}}';
      const threads = [
        ["stopped-thread", "project-kept", "completed", "{}", "2026-08-01"],
        ["fork-thread", "project-kept", "completed", forkPayload, "2026-08-02"],
        ["running-thread", "project-kept", "running", "{}", "2026-08-05"],
        ["settled-thread", "project-kept", "completed", '{"settledAt":"2026-08-01"}', "2026-08-05"],
        [
          "archived-thread",
          "project-kept",
          "completed",
          '{"archivedAt":"2026-08-01"}',
          "2026-08-05",
        ],
        [
          "limit-thread",
          "project-kept",
          "completed",
          '{"limitRecovery":{"autoResume":true}}',
          "2026-08-05",
        ],
        ["subagent-parent", "project-kept", "completed", "{}", "2026-08-05"],
        ["subagent-child", "project-kept", "completed", subagentPayload, "2026-08-05"],
        ["deleted-project-thread", "project-deleted", "completed", "{}", "2026-08-05"],
      ] as const;
      for (const [threadId, projectId, runStatus, payload, updatedAt] of threads) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${threadId}, ${projectId}, ${threadId}, 'codex', 'full-access', 'default', '2026-08-01', ${updatedAt}, ${payload})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', ${runStatus}, '2026-08-01', '{}')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${threadId}`}, 'thread', ${threadId}, 0, 'thread.created', '2026-08-01', 'user', '{}', '{}')`;
      }
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('session-shared', 'running-thread', 'codex', 'stopped', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
        (provider_session_id, thread_id)
        VALUES ('session-shared', 'running-thread'), ('session-shared', 'stopped-thread')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
        VALUES ('transfer-1', 'archived-thread', 'stopped-thread', 'provider_handoff', 'completed', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO scheduled_tasks
        (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
          model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, last_run_status, run_count)
        VALUES ('task-1', 'Nightly', 'Run it', 1, '{}', 'project-kept', '{}', '{}',
          'full-access', 'default', 'user', 'user', '2026-08-01', '2026-08-01', 'never', 0)`;
      yield* sql`INSERT INTO scheduled_task_webhook_replay_keys
        (task_id, replay_key, delivery_id, expires_at)
        VALUES ('task-1', 'replay-1', 'delivery-1', 1900000000000)`;
      yield* sql`INSERT INTO scheduled_task_webhook_pending
        (delivery_id, task_id, coalesce_key, due_at, task_json, request_json, delivery_ids_json)
        VALUES ('delivery-1', 'task-1', 'key-1', 1900000000000, '{}', '{}', '[]')`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
    }),
  );
  return databasePath;
});

const layer = SpacesDatabaseTools.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("migrate-dev-db", (it) => {
  it.effect.each([
    { name: "chat SHM and Spaces main", target: "statev2.sqlite-shm", owner: "spaces" },
    { name: "chat SHM and source main", target: "statev2.sqlite-shm", owner: "source" },
    {
      name: "snapshot journal and Spaces main",
      target: "statev2.sqlite.migrate-dev-db-tmp-journal",
      owner: "spaces",
    },
    { name: "Spaces SHM and its own main", target: "spaces.sqlite-shm", owner: "spaces" },
  ])("refuses hardlinked database roles: $name", ({ target, owner }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-hardlink-source-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-hardlink-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const chat = yield* createFixtureSource(destDir);
      yield* withDatabase(
        chat,
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`PRAGMA journal_mode = WAL`),
      );
      const stateDir = path.dirname(chat);
      const spacesPath = path.join(stateDir, "spaces.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        yield* sql`UPDATE spaces SET title = 'KEEP SPACES DATA', revision = 7 WHERE is_default = 1`;
      }).pipe(Effect.provide(SpacesSqlite.layerFromPath(spacesPath)));
      const backing = owner === "source" ? source : spacesPath;
      const linkedPath = path.join(stateDir, target);
      yield* fs.link(backing, linkedPath);
      const backingInfo = yield* fs.stat(backing);
      const linkedInfo = yield* fs.stat(linkedPath);
      assert.isTrue(Option.isSome(backingInfo.ino));
      assert.equal(backingInfo.dev, linkedInfo.dev);
      assert.deepEqual(backingInfo.ino, linkedInfo.ino);
      const beforeSource = yield* fs.readFile(source);
      const beforeSpaces = yield* fs.readFile(spacesPath);
      const beforeChat = yield* fs.readFile(chat);
      const sourceFiles = (yield* fs.readDirectory(path.dirname(source))).sort();
      const destinationFiles = (yield* fs.readDirectory(stateDir)).sort();

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      ).pipe(Effect.result);
      const actualSource = yield* fs.readFile(source);
      const actualSpaces = yield* fs.readFile(spacesPath);
      assert.equal(
        Buffer.compare(actualSource, beforeSource),
        0,
        "Hardlinked source bytes changed",
      );
      assert.equal(
        Buffer.compare(actualSpaces, beforeSpaces),
        0,
        "Hardlinked Spaces bytes changed",
      );
      assert.isTrue(Result.isFailure(result), "Migration accepted hardlinked database roles");
      if (Result.isFailure(result))
        assert.equal(
          result.failure._tag,
          owner === "source"
            ? "MigrateDevDbSourceIsDestinationError"
            : "MigrateDevDbDatabaseOverlapError",
        );
      assert.equal(Buffer.compare(yield* fs.readFile(chat), beforeChat), 0);
      assert.deepEqual((yield* fs.readDirectory(path.dirname(source))).sort(), sourceFiles);
      assert.deepEqual((yield* fs.readDirectory(stateDir)).sort(), destinationFiles);
      const verification = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-hardlink-verify-",
      });
      const verifiedSpaces = path.join(verification, "spaces.sqlite");
      const verifiedSource = path.join(verification, "source.sqlite");
      yield* fs.writeFile(verifiedSpaces, actualSpaces);
      yield* fs.writeFile(verifiedSource, actualSource);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT title, revision FROM spaces WHERE is_default = 1`, [
          { title: "KEEP SPACES DATA", revision: 7 },
        ]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: verifiedSpaces, readonly: true })));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql`SELECT title FROM projection_projects WHERE project_id = 'project-kept'`)[0]
            ?.title,
          "Kept",
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: verifiedSource, readonly: true })));
    }),
  );

  it.effect.each(["missing", "zero"] as const)(
    "refuses an existing file with %s filesystem identity without accessing SQLite",
    (identity) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-identity-source-" });
        const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-identity-dest-" });
        const source = yield* createFixtureSource(sourceDir);
        const canonicalSource = yield* fs.realPath(source);
        const before = yield* fs.readFile(source);
        const result = yield* runMigrateDevDb(
          { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
          { sharedHome: sourceDir },
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: (file) =>
              fs
                .stat(file)
                .pipe(
                  Effect.map((info) =>
                    file === source || file === canonicalSource
                      ? { ...info, ino: identity === "missing" ? Option.none() : Option.some(0n) }
                      : info,
                  ),
                ),
          }),
          Effect.result,
        );
        assert.isTrue(
          Result.isFailure(result),
          "Migration accepted unavailable filesystem identity",
        );
        if (Result.isFailure(result))
          assert.equal(result.failure._tag, "MigrateDevDbFileIdentityUnavailableError");
        assert.equal(Buffer.compare(yield* fs.readFile(source), before), 0);
        assert.deepEqual(yield* fs.readDirectory(destDir), []);
      }),
  );

  it.effect("allows the configured and resolved names of one contained Spaces main", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-own-role-source-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-own-role-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const stateDir = path.join(destDir, "userdata");
      const backing = path.join(stateDir, "spaces-store.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        yield* sql`UPDATE spaces SET title = 'KEEP SPACES DATA' WHERE is_default = 1`;
      }).pipe(Effect.provide(SpacesSqlite.layerFromPath(backing)));
      yield* fs.symlink(backing, path.join(stateDir, "spaces.sqlite"));
      const before = yield* fs.readFile(backing);
      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );
      assert.equal(result.databasePath, path.join(stateDir, "statev2.sqlite"));
      assert.equal(Buffer.compare(yield* fs.readFile(backing), before), 0);
    }),
  );

  it.effect.each([
    {
      name: "Spaces main to snapshot",
      target: "statev2.sqlite.migrate-dev-db-tmp",
      reverse: false,
    },
    {
      name: "Spaces main to snapshot WAL",
      target: "statev2.sqlite.migrate-dev-db-tmp-wal",
      reverse: false,
    },
    { name: "Spaces main to chat SHM", target: "statev2.sqlite-shm", reverse: false },
    {
      name: "Spaces main to snapshot journal",
      target: "statev2.sqlite.migrate-dev-db-tmp-journal",
      reverse: false,
    },
    {
      name: "snapshot SHM to Spaces main",
      target: "statev2.sqlite.migrate-dev-db-tmp-shm",
      reverse: true,
    },
  ])("refuses overlapping database families: $name", ({ target, reverse }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-overlap-source-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-overlap-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const stateDir = path.join(destDir, "userdata");
      const spacesPath = path.join(stateDir, "spaces.sqlite");
      const targetPath = path.join(stateDir, target);
      const backingPath = reverse ? spacesPath : targetPath;
      yield* Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        yield* sql`UPDATE spaces SET title = 'EXISTING SANDBOX DATA', revision = 7 WHERE is_default = 1`;
      }).pipe(Effect.provide(SpacesSqlite.layerFromPath(backingPath)));
      yield* fs.symlink(backingPath, reverse ? targetPath : spacesPath);
      const before = yield* fs.readFile(backingPath);
      const beforeSource = yield* fs.readFile(source);
      const sourceFiles = (yield* fs.readDirectory(path.dirname(source))).sort();
      const destinationFiles = (yield* fs.readDirectory(stateDir)).sort();

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      ).pipe(Effect.result);
      assert.isTrue(yield* fs.exists(backingPath), "Existing Spaces backing file was deleted");
      assert.equal(
        Buffer.compare(yield* fs.readFile(backingPath), before),
        0,
        "Existing Spaces bytes changed",
      );
      assert.isTrue(Result.isFailure(result), "Migration accepted overlapping database families");
      if (Result.isFailure(result))
        assert.equal(result.failure._tag, "MigrateDevDbDatabaseOverlapError");
      assert.equal(Buffer.compare(yield* fs.readFile(source), beforeSource), 0);
      assert.deepEqual((yield* fs.readDirectory(path.dirname(source))).sort(), sourceFiles);
      assert.deepEqual((yield* fs.readDirectory(stateDir)).sort(), destinationFiles);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT title, revision FROM spaces WHERE is_default = 1`, [
          { title: "EXISTING SANDBOX DATA", revision: 7 },
        ]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: backingPath, readonly: true })));
    }),
  );

  it.effect("refuses a snapshot main alias to committed Spaces WAL before inspection", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-wal-alias-source-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-wal-alias-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const stateDir = path.join(destDir, "userdata");
      const spacesPath = path.join(stateDir, "spaces.sqlite");
      yield* SpacesSql.SpacesSql.pipe(Effect.provide(SpacesSqlite.layerFromPath(spacesPath)));
      const writer = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1]);
        db.exec("PRAGMA wal_autocheckpoint = 0; UPDATE spaces SET title = 'EXISTING SANDBOX DATA', revision = 7 WHERE is_default = 1");
        process.exit(0);
      `,
          spacesPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(writer.status, 0, writer.stderr);
      const walPath = `${spacesPath}-wal`;
      const shmPath = `${spacesPath}-shm`;
      yield* fs.symlink(walPath, path.join(stateDir, "statev2.sqlite.migrate-dev-db-tmp"));
      const before = yield* fs.readFile(spacesPath);
      const wal = yield* fs.readFile(walPath);
      const shm = yield* fs.readFile(shmPath);
      assert.isAbove(wal.length, 32);
      const beforeSource = yield* fs.readFile(source);
      const sourceFiles = (yield* fs.readDirectory(path.dirname(source))).sort();
      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      ).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result), "Migration accepted a Spaces WAL overlap");
      if (Result.isFailure(result))
        assert.equal(result.failure._tag, "MigrateDevDbDatabaseOverlapError");
      assert.equal(Buffer.compare(yield* fs.readFile(spacesPath), before), 0);
      assert.equal(Buffer.compare(yield* fs.readFile(walPath), wal), 0);
      assert.equal(Buffer.compare(yield* fs.readFile(shmPath), shm), 0);
      assert.equal(Buffer.compare(yield* fs.readFile(source), beforeSource), 0);
      assert.deepEqual((yield* fs.readDirectory(path.dirname(source))).sort(), sourceFiles);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT title, revision FROM spaces WHERE is_default = 1`, [
          { title: "EXISTING SANDBOX DATA", revision: 7 },
        ]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: spacesPath, readonly: true })));
    }),
  );

  it.effect.each(["database", "parent", "missing-parent"] as const)(
    "refuses escaping Spaces %s symlinks before inspection",
    (alias) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-spaces-alias-" });
        const sourceDir = path.join(root, "sandbox-outside");
        const destDir = path.join(root, "sandbox");
        yield* fs.makeDirectory(sourceDir);
        yield* fs.makeDirectory(destDir);
        const sourceChat = yield* createFixtureSource(sourceDir);
        const sourceSpaces = path.join(sourceDir, "userdata", "spaces.sqlite");
        yield* SpacesSql.SpacesSql.pipe(Effect.provide(SpacesSqlite.layerFromPath(sourceSpaces)));
        const source =
          alias === "database"
            ? sourceChat
            : yield* createFixtureSource(path.join(root, "chat-source"));
        const destinationState = path.join(destDir, "userdata");
        if (alias === "database") {
          yield* fs.makeDirectory(destinationState);
          yield* fs.symlink(sourceSpaces, path.join(destinationState, "spaces.sqlite"));
        } else {
          yield* fs.symlink(
            alias === "parent"
              ? path.dirname(sourceSpaces)
              : path.join(path.dirname(sourceSpaces), "missing-userdata"),
            destinationState,
          );
        }
        const sourceFiles = (yield* fs.readDirectory(path.dirname(sourceSpaces))).sort();
        assert.isFalse(yield* fs.exists(`${sourceSpaces}-wal`));
        assert.isFalse(yield* fs.exists(`${sourceSpaces}-shm`));
        const beforeSpaces = yield* fs.readFile(sourceSpaces);
        const beforeChat = yield* fs.readFile(sourceChat);
        const result = yield* runMigrateDevDb(
          { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
          { sharedHome: path.join(root, "protected-home") },
        ).pipe(Effect.result);
        assert.isTrue(
          Result.isFailure(result),
          "Migration accepted a destination outside its sandbox",
        );
        if (Result.isFailure(result))
          assert.equal(result.failure._tag, "MigrateDevDbDestinationOutsideSandboxError");
        assert.equal(Buffer.compare(yield* fs.readFile(sourceSpaces), beforeSpaces), 0);
        assert.equal(Buffer.compare(yield* fs.readFile(sourceChat), beforeChat), 0);
        assert.deepEqual((yield* fs.readDirectory(path.dirname(sourceSpaces))).sort(), sourceFiles);
      }),
  );
  it.effect("initializes Spaces empty and preserves sandbox changes across chat refreshes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-spaces-source-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-spaces-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const sourceSpaces = path.join(sourceDir, "userdata", "spaces.sqlite");
      yield* fs.writeFileString(sourceSpaces, "Source Spaces must never be opened");
      const sourceAssets = path.join(sourceDir, "userdata", "spaces", "assets");
      yield* fs.makeDirectory(sourceAssets, { recursive: true });
      yield* fs.writeFileString(path.join(sourceAssets, "original"), "source asset");
      const input = { baseDir: destDir, source, projects: 5, threadsPerProject: 2 };
      yield* runMigrateDevDb(input, { sharedHome: sourceDir });
      const destination = path.join(destDir, "userdata", "spaces.sqlite");
      assert.isTrue(yield* fs.exists(destination));
      yield* Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        assert.deepEqual(yield* sql`SELECT title, is_default FROM spaces`, [
          { title: "My space", is_default: 1 },
        ]);
        yield* sql`UPDATE spaces SET title = 'Sandbox work', revision = 1 WHERE is_default = 1`;
      }).pipe(Effect.provide(SpacesSqlite.layerFromPath(destination)));
      const before = yield* fs.readFile(destination);
      yield* runMigrateDevDb(input, { sharedHome: sourceDir });
      assert.equal(Buffer.compare(yield* fs.readFile(destination), before), 0);
      assert.equal(yield* fs.readFileString(sourceSpaces), "Source Spaces must never be opened");
      assert.isFalse(yield* fs.exists(path.join(destDir, "userdata", "spaces")));
      yield* withDatabase(
        destination,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(yield* sql`SELECT title, revision FROM spaces`, [
            { title: "Sandbox work", revision: 1 },
          ]);
          assert.deepEqual(
            yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
            [
              { migration_id: 1, name: "Spaces" },
              { migration_id: 2, name: "Core" },
            ],
          );
        }),
      );
    }),
  );

  it.effect("refuses a foreign Spaces destination before replacing the sandbox chat database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-spaces-foreign-src-",
      });
      const destDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-spaces-foreign-dest-",
      });
      const source = yield* createFixtureSource(sourceDir);
      const chat = yield* createFixtureSource(destDir);
      const destination = path.join(destDir, "userdata", "spaces.sqlite");
      yield* withDatabase(
        destination,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE keep_foreign (value TEXT)`;
          yield* sql`INSERT INTO keep_foreign VALUES ('untouched')`;
        }),
      );
      const beforeChat = yield* fs.readFile(chat);
      const beforeSpaces = yield* fs.readFile(destination);
      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbPhaseError");
      if (error._tag === "MigrateDevDbPhaseError") assert.equal(error.phase, "spaces");
      assert.equal(Buffer.compare(yield* fs.readFile(chat), beforeChat), 0);
      assert.equal(Buffer.compare(yield* fs.readFile(destination), beforeSpaces), 0);
      assert.isFalse(yield* fs.exists(`${chat}.migrate-dev-db-tmp`));
    }),
  );

  it.effect("keeps stopped and settled thread families and clears pending work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-dest-" });
      const source = yield* createFixtureSource(sourceDir);

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );

      assert.equal(result.databasePath, path.join(destDir, "userdata", "statev2.sqlite"));
      const kept = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          const events = yield* sql<{ stream_id: string }>`
            SELECT stream_id FROM orchestration_events ORDER BY stream_id`;
          const sessions = yield* sql<{ provider_session_id: string }>`
            SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions`;
          const [leftovers] = yield* sql<{
            auth: number;
            tasks: number;
            webhooks: number;
            transfers: number;
          }>`
            SELECT
              (SELECT COUNT(*) FROM auth_sessions) AS auth,
              (SELECT COUNT(*) FROM scheduled_tasks) AS tasks,
              (SELECT COUNT(*) FROM scheduled_task_webhook_replay_keys) +
                (SELECT COUNT(*) FROM scheduled_task_webhook_pending) AS webhooks,
              (SELECT COUNT(*) FROM orchestration_v2_projection_context_transfers) AS transfers`;
          return { threads, events, sessions, leftovers };
        }),
      );
      assert.deepStrictEqual(
        kept.threads.map((row) => row.thread_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.events.map((row) => row.stream_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.sessions.map((row) => row.provider_session_id),
        ["session-shared"],
      );
      assert.deepStrictEqual(kept.leftovers, { auth: 0, tasks: 0, webhooks: 0, transfers: 0 });
    }),
  );

  it.effect("never copies an archived thread, and new events append after the source's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slice-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slice-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const [sourceSequence] = yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ seq: number }>`
            SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 100 },
        { sharedHome: sourceDir },
      );

      const copied = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [archivedRows] = yield* sql<{ count: number }>`
            SELECT
              (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id = 'archived-thread')
              + (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = 'archived-thread')
              AS count`;
          const [sequence] = yield* sql<{ seq: number }>`
            SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'`;
          return { archivedRows: archivedRows?.count, sequence: sequence?.seq };
        }),
      );
      assert.equal(copied.archivedRows, 0);
      assert.equal(copied.sequence, sourceSequence?.seq);
    }),
  );

  it.effect("skips a thread family larger than the per-project limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-family-" });
      const destDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-dev-db-family-dest-",
      });
      const source = yield* createFixtureSource(sourceDir);

      // stopped-thread and its fork are 2 threads; settled-thread is 1.
      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 1 },
        { sharedHome: sourceDir },
      );
      const threads = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads`;
        }),
      );
      assert.deepStrictEqual(
        threads.map((row) => row.thread_id),
        ["settled-thread"],
      );
    }),
  );

  it.effect("upgrades a source from before the V2 thread tables", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-dest-" });
      const stateDir = path.join(sourceDir, "userdata");
      const source = path.join(stateDir, "statev2.sqlite");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* withDatabase(source, runMigrations({ toMigrationInclusive: 54 }));

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );
      assert.include(result.executedMigrations, "55_OrchestrationV2");
    }),
  );

  it.effect("refuses while a dev server holds the destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const stateDir = path.join(destDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        `{"version":1,"pid":${process.pid}}`,
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbServerRunningError");
      if (error._tag === "MigrateDevDbServerRunningError") {
        assert.equal(error.pid, process.pid);
      }
      assert.isFalse(yield* fs.exists(path.join(stateDir, "spaces.sqlite")));
    }),
  );

  it.effect.each(["statev2.sqlite.migrate-dev-db-tmp", "spaces.sqlite"])(
    "refuses a source that resolves to destination %s",
    (name) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-overlap-",
        });
        const destDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-overlap-dest-",
        });
        const leftoverSnapshot = path.join(destDir, "userdata", name);
        yield* fs.makeDirectory(path.dirname(leftoverSnapshot), { recursive: true });
        yield* fs.writeFileString(leftoverSnapshot, "not a real db");

        const error = yield* runMigrateDevDb(
          { baseDir: destDir, source: leftoverSnapshot, projects: 5, threadsPerProject: 10 },
          { sharedHome: sharedDir },
        ).pipe(Effect.flip);
        assert.equal(error._tag, "MigrateDevDbSourceIsDestinationError");
        assert.equal(yield* fs.exists(leftoverSnapshot), true);
      }),
  );

  it.effect("refuses userdata linked into the protected shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-spaces-alias-src-",
      });
      const sharedDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-spaces-shared-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-spaces-alias-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const protectedState = path.join(sharedDir, "userdata");
      yield* fs.makeDirectory(protectedState);
      yield* fs.symlink(protectedState, path.join(destDir, "userdata"));
      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sharedDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSharedHomeError");
      assert.deepEqual(yield* fs.readDirectory(protectedState), []);
    }),
  );

  it.effect("refuses to rebuild the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-shared-" });
      const source = yield* createFixtureSource(sourceDir);

      const error = yield* runMigrateDevDb(
        { baseDir: sourceDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSharedHomeError");
    }),
  );
});
