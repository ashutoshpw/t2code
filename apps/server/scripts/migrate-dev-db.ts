#!/usr/bin/env node

/**
 * Rebuild an isolated dev database from a pruned snapshot of the real ~/.t2
 * database, then migrate it: recent projects with fully-stopped threads
 * survive, live work does not. The clone keeps `effect_sql_migrations`, so a
 * new migration must apply on top; duplicate `Migrations/NNN_` ids fail.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { resolveWorktreeT2Home } from "@t2code/shared/devHome";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag } from "effect/cli";

import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as SpacesDatabaseTools from "../src/spaces/SpacesDatabaseTools.ts";
import { rebuildMessageSearch } from "../src/orchestration-v2/messageSearchIndex.ts";
import { migrationManifest, runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";

export class MigrateDevDbNotInWorktreeError extends Schema.TaggedError<MigrateDevDbNotInWorktreeError>()(
  "MigrateDevDbNotInWorktreeError",
  {},
) {
  override get message(): string {
    return "Not inside a linked git worktree. Pass --base-dir to target an isolated .t2 directory.";
  }
}

export class MigrateDevDbSharedHomeError extends Schema.TaggedError<MigrateDevDbSharedHomeError>()(
  "MigrateDevDbSharedHomeError",
  {},
) {
  override get message(): string {
    return "Refusing to rebuild the shared ~/.t2 database. Use an isolated --base-dir.";
  }
}

export class MigrateDevDbSourceMissingError extends Schema.TaggedError<MigrateDevDbSourceMissingError>()(
  "MigrateDevDbSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Source database does not exist at '${this.sourcePath}'.`;
  }
}

export class MigrateDevDbSourceIsDestinationError extends Schema.TaggedError<MigrateDevDbSourceIsDestinationError>()(
  "MigrateDevDbSourceIsDestinationError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Source database '${this.sourcePath}' resolves to a path this command rewrites. Pick a different --source or --base-dir.`;
  }
}

export class MigrateDevDbDestinationOutsideSandboxError extends Schema.TaggedError<MigrateDevDbDestinationOutsideSandboxError>()(
  "MigrateDevDbDestinationOutsideSandboxError",
  { destinationPath: Schema.String },
) {
  override get message() {
    return "Refusing to access a database destination outside the isolated sandbox.";
  }
}

export class MigrateDevDbDatabaseOverlapError extends Schema.TaggedError<MigrateDevDbDatabaseOverlapError>()(
  "MigrateDevDbDatabaseOverlapError",
  { path: Schema.String },
) {
  override get message() {
    return "Refusing to migrate overlapping database file families.";
  }
}

export class MigrateDevDbFileIdentityUnavailableError extends Schema.TaggedError<MigrateDevDbFileIdentityUnavailableError>()(
  "MigrateDevDbFileIdentityUnavailableError",
  { path: Schema.String },
) {
  override get message() {
    return "Cannot safely migrate because the filesystem does not report a usable file identity.";
  }
}

export class MigrateDevDbServerRunningError extends Schema.TaggedError<MigrateDevDbServerRunningError>()(
  "MigrateDevDbServerRunningError",
  {
    databasePath: Schema.String,
    pid: Schema.Number,
  },
) {
  override get message(): string {
    return `Dev database at '${this.databasePath}' is open by a running server (pid ${this.pid} per server-runtime.json). Stop that server first; if that pid is not actually a T2 server (stale descriptor, reused pid), delete the server-runtime.json next to the database and retry.`;
  }
}

export class MigrateDevDbDestinationBusyError extends Schema.TaggedError<MigrateDevDbDestinationBusyError>()(
  "MigrateDevDbDestinationBusyError",
  {
    databasePath: Schema.String,
    reason: Schema.Literals(["write-locked", "wal-held"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail =
      this.reason === "write-locked"
        ? "the database is write-locked"
        : "another connection is holding its WAL";
    return `Dev database at '${this.databasePath}' looks in use (${detail}). Stop the dev server first; if none is running, delete the -wal/-shm files next to it.`;
  }
}

export class MigrateDevDbSlotCollisionError extends Schema.TaggedError<MigrateDevDbSlotCollisionError>()(
  "MigrateDevDbSlotCollisionError",
  {
    slot: Schema.Number,
    codeName: Schema.String,
    appliedName: Schema.String,
  },
) {
  override get message(): string {
    return `Migration slot collision at ${this.slot}: this checkout registers '${this.codeName}' but the database already applied '${this.appliedName}' in that slot. Renumber the new migration to a free slot.`;
  }
}

export class MigrateDevDbPhaseError extends Schema.TaggedError<MigrateDevDbPhaseError>()(
  "MigrateDevDbPhaseError",
  {
    phase: Schema.Literals(["snapshot", "prune", "compact", "migrate", "verify", "spaces"]),
    databasePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `migrate-dev-db failed during ${this.phase} on '${this.databasePath}'.`;
  }
}

export interface RunMigrateDevDbInput {
  readonly baseDir?: string | undefined;
  readonly source?: string | undefined;
  readonly projects: number;
  readonly threadsPerProject: number;
}

export interface RunMigrateDevDbOptions {
  /** Test override for the directory writes must never target. */
  readonly sharedHome?: string | undefined;
}

interface KeptProject {
  readonly title: string;
  readonly threads: number;
}

const DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;
// Fresh chat snapshots use rollback journals before WAL mode is restored.
const DATABASE_ACCESS_SUFFIXES = [...DATABASE_FILE_SUFFIXES, "-journal"];

const removeDatabaseFiles = Effect.fn("removeDatabaseFiles")(function* (databasePath: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const suffix of DATABASE_FILE_SUFFIXES) {
    yield* fs.remove(`${databasePath}${suffix}`).pipe(Effect.orElseSucceed(() => undefined));
  }
});

const ServerRuntimeState = Schema.fromJsonString(Schema.Struct({ pid: Schema.Number }));
const decodeServerRuntimeState = Schema.decodeEffect(ServerRuntimeState);

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// The runtime PID catches idle servers; leftover -shm files can come from read-only connections.
const ensureNotInUse = Effect.fn("ensureDevDbNotInUse")(function* (databasePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runtimeStatePath = path.join(path.dirname(databasePath), "server-runtime.json");
  const runtimeState = yield* fs
    .readFileString(runtimeStatePath)
    .pipe(Effect.flatMap(decodeServerRuntimeState), Effect.option);
  if (Option.isSome(runtimeState) && isProcessAlive(runtimeState.value.pid)) {
    return yield* new MigrateDevDbServerRunningError({
      databasePath,
      pid: runtimeState.value.pid,
    });
  }

  if (!(yield* fs.exists(databasePath))) {
    return;
  }
  const checkpoint = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 0").unprepared;
    yield* sql.unsafe("BEGIN IMMEDIATE").unprepared;
    yield* sql.unsafe("ROLLBACK").unprepared;
    return yield* sql.unsafe<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)").unprepared;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    Effect.mapError(
      (cause) =>
        new MigrateDevDbDestinationBusyError({
          databasePath,
          reason: "write-locked",
          cause,
        }),
    ),
  );
  if (checkpoint[0] !== undefined && Number(checkpoint[0].busy) !== 0) {
    return yield* new MigrateDevDbDestinationBusyError({
      databasePath,
      reason: "wal-held",
    });
  }
});

const RECOVERY_KINDS: ReadonlyArray<ProjectionStore.ProjectionRecoveryKind> = [
  "queued-runs",
  "runtime",
  "subagent-results",
  "delegated-completions",
];

const CLEARED_TABLES: ReadonlyArray<string> = [
  "scheduled_tasks",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_thread_launch_workflows",
  "orchestration_command_receipts",
  "provider_session_runtime",
  "auth_sessions",
  "auth_pairing_links",
];

const PROVIDER_SESSIONS_TABLE = "orchestration_v2_projection_provider_sessions";
const FTS5_SHADOW_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"];

// Settled threads stay: they are most of real history, and the UI shows them.
const rootIsVisible = (sql: SqlClient.SqlClient) => sql`
  root.deleted_at IS NULL
  AND json_extract(root.payload_json, '$.deletedAt') IS NULL
  AND json_extract(root.payload_json, '$.archivedAt') IS NULL`;

// A single read transaction keeps the copy consistent with concurrent server writes.
const copySourceSlice = Effect.fn("copyDevDbSourceSlice")(function* (sourcePath: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ATTACH DATABASE ${`${NodeURL.pathToFileURL(sourcePath).href}?mode=ro`} AS src`;
  const schema = yield* sql<{ type: string; name: string; sql: string }>`
    SELECT type, name, sql FROM src.sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`;
  const threadColumns = yield* sql<{ name: string; notnull: number }>`
    SELECT m.name, c."notnull" FROM src.sqlite_master m, pragma_table_info(m.name, 'src') c
    WHERE m.type = 'table' AND c.name = 'thread_id'`;
  const threadIdNullable = new Map(threadColumns.map((row) => [row.name, row.notnull === 0]));
  // FTS5 makes its own shadow tables and contentless rows cannot be copied:
  // create the virtual table, skip its shadow tables and rows, and rebuild the
  // index once the messages and triggers are in.
  const virtualTables = schema
    .filter((entry) => entry.type === "table" && /^CREATE VIRTUAL TABLE/i.test(entry.sql))
    .map((entry) => entry.name);
  const isShadowTable = (name: string) =>
    virtualTables.some((virtual) =>
      FTS5_SHADOW_SUFFIXES.some((suffix) => name === `${virtual}${suffix}`),
    );
  const tables = schema.filter((entry) => entry.type === "table" && !isShadowTable(entry.name));
  const filtered = tables.some((table) => table.name === "orchestration_v2_projection_threads");
  // A row that points into a cleared table cannot be copied, so whatever references one is
  // cleared with it, however far down the chain a newer migration added it.
  const references = yield* sql<{ name: string; parent: string }>`
    SELECT m.name, f."table" AS parent FROM src.sqlite_master m, pragma_foreign_key_list(m.name, 'src') f
    WHERE m.type = 'table'`;
  const cleared = new Set(CLEARED_TABLES);
  for (let grew = true; grew;) {
    grew = false;
    for (const { name, parent } of references) {
      if (cleared.has(parent) && !cleared.has(name)) {
        cleared.add(name);
        grew = true;
      }
    }
  }

  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const table of tables) yield* sql.unsafe(table.sql).unprepared;
      if (filtered) {
        yield* sql`CREATE TEMP TABLE copied_threads (thread_id TEXT PRIMARY KEY)`;
        yield* sql`INSERT OR IGNORE INTO copied_threads
          SELECT family.thread_id FROM src.orchestration_v2_projection_threads family
          JOIN src.orchestration_v2_projection_threads root ON root.thread_id =
            COALESCE(json_extract(family.payload_json, '$.lineage.rootThreadId'), family.thread_id)
          WHERE ${rootIsVisible(sql)}`;
      }
      for (const { name } of tables) {
        if (cleared.has(name) || virtualTables.includes(name)) continue;
        const nullable = threadIdNullable.get(name);
        const filter = !filtered
          ? ""
          : name === "orchestration_events"
            ? // Two ranges let SQLite seek the (aggregate_kind, stream_id) index instead of scanning.
              `WHERE (aggregate_kind = 'thread' AND stream_id IN (SELECT thread_id FROM copied_threads))
                OR aggregate_kind < 'thread' OR aggregate_kind > 'thread'`
            : nullable === undefined || name === PROVIDER_SESSIONS_TABLE
              ? ""
              : `WHERE thread_id IN (SELECT thread_id FROM copied_threads)${nullable ? " OR thread_id IS NULL" : ""}`;
        yield* sql.unsafe(`INSERT INTO main."${name}" SELECT * FROM src."${name}" ${filter}`)
          .unprepared;
      }
      yield* sql`DELETE FROM main.sqlite_sequence`;
      yield* sql`INSERT INTO main.sqlite_sequence SELECT name, seq FROM src.sqlite_sequence`;
      for (const entry of schema) {
        if (entry.type !== "table") yield* sql.unsafe(entry.sql).unprepared;
      }
      yield* rebuildMessageSearch(sql);
    }),
  );
  yield* sql`DETACH DATABASE src`;
});

const pruneSnapshot = Effect.fn("pruneDevDbSnapshot")(function* (input: RunMigrateDevDbInput) {
  const sql = yield* SqlClient.SqlClient;

  // Usage-limit recovery also depends on settings; exclude latest-run failures and recovery choices.
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const recoveryThreadIds = yield* Effect.forEach(RECOVERY_KINDS, (kind) =>
    projections.getRecoveryThreadIds(kind),
  );
  yield* sql`CREATE TEMP TABLE live_threads (thread_id TEXT PRIMARY KEY)`;
  for (const threadId of new Set(recoveryThreadIds.flat())) {
    yield* sql`INSERT INTO live_threads (thread_id) VALUES (${threadId})`;
  }
  yield* sql`INSERT OR IGNORE INTO live_threads (thread_id)
    SELECT r.thread_id FROM orchestration_v2_projection_runs r
    WHERE r.status = 'failed' AND r.ordinal = (
      SELECT MAX(latest.ordinal) FROM orchestration_v2_projection_runs latest
      WHERE latest.thread_id = r.thread_id)
    UNION
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE json_extract(payload_json, '$.limitRecovery') IS NOT NULL`;

  // Clone or drop whole thread families to preserve fork and subagent lineage reads.
  yield* sql`CREATE TEMP TABLE thread_families AS
    SELECT thread_id, updated_at,
      COALESCE(json_extract(payload_json, '$.lineage.rootThreadId'), thread_id) AS root_id
    FROM orchestration_v2_projection_threads`;

  yield* sql`CREATE TEMP TABLE stopped_families AS
    SELECT f.root_id, root.project_id, MAX(f.updated_at) AS updated_at, COUNT(*) AS size
    FROM thread_families f
    JOIN orchestration_v2_projection_threads root ON root.thread_id = f.root_id
    WHERE ${rootIsVisible(sql)}
    GROUP BY f.root_id, root.project_id
    HAVING SUM(f.thread_id IN (SELECT thread_id FROM live_threads)) = 0`;

  yield* sql`CREATE TEMP TABLE kept_projects AS
    SELECT p.project_id
    FROM projection_projects p
    LEFT JOIN (
      SELECT project_id, MAX(updated_at) AS last_stopped_at
      FROM stopped_families
      GROUP BY project_id
    ) q ON q.project_id = p.project_id
    WHERE p.deleted_at IS NULL
    ORDER BY (q.last_stopped_at IS NULL) ASC,
      COALESCE(q.last_stopped_at, p.updated_at) DESC
    LIMIT ${input.projects}`;

  yield* sql`CREATE TEMP TABLE kept_threads AS
    SELECT f.thread_id FROM thread_families f
    WHERE f.root_id IN (
      SELECT root_id FROM (
        SELECT
          sf.root_id,
          ROW_NUMBER() OVER (
            PARTITION BY sf.project_id
            ORDER BY sf.updated_at DESC
          ) AS recency_rank
        FROM stopped_families sf
        JOIN kept_projects kp ON kp.project_id = sf.project_id
        -- One orchestrator family can hold hundreds of subagents and most of
        -- the database, so a family larger than the limit is skipped.
        WHERE sf.size <= ${input.threadsPerProject}
      )
      WHERE recency_rank <= ${input.threadsPerProject}
    )`;

  const threadTables = yield* sql<{ name: string }>`
    SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
    WHERE m.type = 'table' AND c.name = 'thread_id'
      AND m.name <> ${PROVIDER_SESSIONS_TABLE}`;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM projection_projects
        WHERE project_id NOT IN (SELECT project_id FROM kept_projects)`;
      yield* sql`DELETE FROM ${sql(PROVIDER_SESSIONS_TABLE)}
        WHERE COALESCE(thread_id, '') NOT IN (SELECT thread_id FROM kept_threads)
          AND provider_session_id NOT IN (
            SELECT provider_session_id FROM orchestration_v2_projection_provider_session_bindings
            WHERE thread_id IN (SELECT thread_id FROM kept_threads)
          )`;
      for (const { name } of threadTables) {
        yield* sql.unsafe(
          `DELETE FROM "${name}" WHERE thread_id NOT IN (SELECT thread_id FROM kept_threads)`,
        ).unprepared;
      }
      yield* sql`DELETE FROM orchestration_v2_projection_context_transfers
        WHERE source_thread_id NOT IN (SELECT thread_id FROM kept_threads)
           OR target_thread_id NOT IN (SELECT thread_id FROM kept_threads)`;
      yield* sql`DELETE FROM orchestration_events
        WHERE (aggregate_kind = 'thread'
            AND stream_id NOT IN (SELECT thread_id FROM kept_threads))
           OR (aggregate_kind = 'project'
            AND stream_id NOT IN (SELECT project_id FROM kept_projects))`;
      for (const table of CLEARED_TABLES) {
        yield* sql`DELETE FROM ${sql(table)}`;
      }
    }),
  );

  const keptProjects = yield* sql<{ title: string; threads: number }>`
    SELECT
      p.title,
      (SELECT COUNT(*) FROM orchestration_v2_projection_threads t
        WHERE t.project_id = p.project_id) AS threads
    FROM projection_projects p
    ORDER BY p.updated_at DESC`;
  const [events] = yield* sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_events`;

  return {
    projects: keptProjects as ReadonlyArray<KeptProject>,
    eventCount: events?.count ?? 0,
  };
});

const verifyMigrationSlots = Effect.fn("verifyMigrationSlots")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const applied = yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations`;
  const appliedById = new Map(applied.map((row) => [Number(row.migration_id), row.name]));
  for (const [slot, codeName] of migrationManifest) {
    const appliedName = appliedById.get(slot);
    if (appliedName !== undefined && appliedName !== codeName) {
      return yield* new MigrateDevDbSlotCollisionError({ slot, codeName, appliedName });
    }
  }
});

const resolveCanonicalPath = Effect.fn("migrateDevDb.resolveCanonicalPath")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(filePath);
  const suffix: string[] = [];
  for (;;) {
    const canonical = yield* fs.realPath(current).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
    );
    if (Option.isSome(canonical)) return path.join(canonical.value, ...suffix);
    const link = yield* fs.readLink(current).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
    );
    if (Option.isSome(link)) {
      // Preserve .. until realpath resolves any symlinked ancestors.
      current = path.isAbsolute(link.value)
        ? link.value
        : `${path.dirname(current)}${path.sep}${link.value}`;
      continue;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.join(yield* fs.realPath(current), ...suffix);
    suffix.unshift(path.basename(current));
    current = parent;
  }
});

const readFileIdentity = Effect.fn("migrateDevDb.readFileIdentity")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(file).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
  );
  if (Option.isNone(info)) return null;
  if (Option.isNone(info.value.ino) || info.value.ino.value <= 0n) {
    return yield* new MigrateDevDbFileIdentityUnavailableError({ path: file });
  }
  return `${info.value.dev}:${info.value.ino.value}`;
});

const resolveDatabaseFamily = Effect.fn("migrateDevDb.resolveDatabaseFamily")(function* (
  databasePath: string,
) {
  const path = yield* Path.Path;
  const canonicalPath = yield* resolveCanonicalPath(databasePath);
  const members = [...new Set([databasePath, canonicalPath])].flatMap((root) =>
    DATABASE_ACCESS_SUFFIXES.map((member) => ({ file: `${root}${member}`, member })),
  );
  const files = yield* Effect.forEach(members, ({ file, member }) =>
    Effect.all([
      resolveCanonicalPath(file),
      resolveCanonicalPath(path.dirname(file)).pipe(
        Effect.map((directory) => path.join(directory, path.basename(file))),
      ),
    ]).pipe(
      Effect.flatMap((paths) =>
        Effect.forEach([...new Set(paths)], (file) =>
          readFileIdentity(file).pipe(Effect.map((identity) => ({ path: file, member, identity }))),
        ),
      ),
    ),
  );
  return { databasePath: canonicalPath, files: files.flat() };
});

type DatabaseFileRole = { readonly family: string; readonly member: string };

export const runMigrateDevDb = Effect.fn("runMigrateDevDb")(function* (
  input: RunMigrateDevDbInput,
  options: RunMigrateDevDbOptions = {},
) {
  // Negative SQLite LIMITs mean unlimited; validate direct callers as well as CLI flags.
  if (input.projects < 1 || input.threadsPerProject < 0) {
    return yield* Effect.die("projects must be >= 1 and threadsPerProject >= 0");
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const sharedHome = path.resolve(options.sharedHome ?? path.join(NodeOS.homedir(), ".t2"));
  const sourcePath = path.resolve(
    input.source ?? path.join(sharedHome, "userdata", "statev2.sqlite"),
  );

  const baseDir =
    input.baseDir !== undefined
      ? path.resolve(input.baseDir)
      : yield* resolveWorktreeT2Home(process.cwd());
  if (baseDir === undefined) {
    return yield* new MigrateDevDbNotInWorktreeError();
  }
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  const snapshotPath = `${databasePath}.migrate-dev-db-tmp`;
  const spacesDatabasePath = path.join(stateDir, "spaces.sqlite");

  if (!(yield* fs.exists(sourcePath))) {
    return yield* new MigrateDevDbSourceMissingError({ sourcePath });
  }
  const [canonicalBaseDir, canonicalSharedHome] = yield* Effect.all([
    resolveCanonicalPath(baseDir),
    resolveCanonicalPath(sharedHome),
  ]);
  if (canonicalBaseDir === canonicalSharedHome) {
    return yield* new MigrateDevDbSharedHomeError();
  }
  const [canonicalStateDir, canonicalSharedStateDir] = yield* Effect.all([
    resolveCanonicalPath(stateDir),
    resolveCanonicalPath(path.join(sharedHome, "userdata")),
  ]);
  if (canonicalStateDir === canonicalSharedStateDir) {
    return yield* new MigrateDevDbSharedHomeError();
  }
  const [sourceFamily, chatFamily, snapshotFamily, spacesFamily] = yield* Effect.all([
    resolveDatabaseFamily(sourcePath),
    resolveDatabaseFamily(databasePath),
    resolveDatabaseFamily(snapshotPath),
    resolveDatabaseFamily(spacesDatabasePath),
  ]);
  const destinations = [chatFamily, snapshotFamily, spacesFamily];
  for (const family of destinations) {
    for (const file of family.files) {
      const relative = path.relative(canonicalBaseDir, file.path);
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return yield* new MigrateDevDbDestinationOutsideSandboxError({
          destinationPath: file.path,
        });
      }
    }
  }
  const occupiedPaths = new Map<string, DatabaseFileRole>();
  const occupiedFiles = new Map<string, DatabaseFileRole>();
  for (const [name, family] of [
    ["source", sourceFamily],
    ["chat", chatFamily],
    ["snapshot", snapshotFamily],
    ["spaces", spacesFamily],
  ] as const) {
    for (const file of family.files) {
      for (const { key, occupied } of [
        { key: file.path, occupied: occupiedPaths },
        { key: file.identity, occupied: occupiedFiles },
      ]) {
        if (key === null) continue;
        const previous = occupied.get(key);
        if (previous && (previous.family !== name || previous.member !== file.member)) {
          if (previous.family !== name && (previous.family === "source" || name === "source")) {
            return yield* new MigrateDevDbSourceIsDestinationError({ sourcePath });
          }
          return yield* new MigrateDevDbDatabaseOverlapError({ path: file.path });
        }
        occupied.set(key, { family: name, member: file.member });
      }
    }
  }
  const canonicalSpacesDatabasePath = spacesFamily.databasePath;

  const wrapPhase =
    (phase: MigrateDevDbPhaseError["phase"], phaseDatabasePath: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new MigrateDevDbPhaseError({ phase, databasePath: phaseDatabasePath, cause }),
        ),
      );

  const spaces = yield* SpacesDatabaseTools.SpacesDatabaseTools;
  const existingSpaces = yield* spaces
    .inspect(canonicalSpacesDatabasePath)
    .pipe(wrapPhase("spaces", spacesDatabasePath));
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* ensureNotInUse(databasePath);
  if (existingSpaces === null) {
    yield* spaces
      .initializeIfMissing(canonicalSpacesDatabasePath)
      .pipe(wrapPhase("spaces", spacesDatabasePath));
  }
  yield* removeDatabaseFiles(snapshotPath);
  const { executedMigrations, pruned } = yield* Effect.gen(function* () {
    yield* Console.log(`Copying visible threads from ${sourcePath} (read-only)...`);
    yield* copySourceSlice(sourcePath).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("snapshot", sourcePath),
    );

    // Migrate first so prune queries can use columns missing from older sources.
    yield* Console.log("Running migrations on the snapshot...");
    const executed = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("PRAGMA foreign_keys = ON").unprepared;
      return yield* runMigrations();
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("migrate", snapshotPath),
    );

    // Detect migration slot collisions before replacing the worktree database.
    yield* verifyMigrationSlots().pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(
            new MigrateDevDbPhaseError({ phase: "verify", databasePath: snapshotPath, cause }),
          ),
      }),
    );

    yield* Console.log(
      `Pruning to ${input.projects} projects, ${input.threadsPerProject} stopped threads each...`,
    );
    const result = yield* pruneSnapshot(input).pipe(
      Effect.provide(
        ProjectionStore.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: snapshotPath })),
        ),
      ),
      wrapPhase("prune", snapshotPath),
    );

    yield* Console.log(`Compacting into ${databasePath}...`);
    // A server may have started during pruning; re-check before replacing its database.
    yield* ensureNotInUse(databasePath);
    yield* removeDatabaseFiles(databasePath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${databasePath}`;
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("compact", databasePath),
    );
    return { executedMigrations: executed, pruned: result };
  }).pipe(Effect.ensuring(removeDatabaseFiles(snapshotPath)));
  yield* fs.chmod(databasePath, 0o600);

  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // VACUUM INTO loses WAL mode; restore the server boot setting.
    yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    wrapPhase("compact", databasePath),
  );

  const size = (yield* fs.stat(databasePath)).size;
  return {
    databasePath,
    sizeBytes: Number(size),
    projects: pruned.projects,
    eventCount: pruned.eventCount,
    executedMigrations: executedMigrations.map(([id, name]) => `${id}_${name}`),
  };
});

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;

export const migrateDevDbCommand = Command.make(
  "migrate-dev-db",
  {
    projects: Flag.Int("projects").pipe(
      Flag.withDefault(5),
      Flag.withDescription("How many recently updated projects to keep."),
    ),
    threadsPerProject: Flag.Int("threads-per-project").pipe(
      Flag.withDefault(10),
      Flag.withDescription(
        "How many recent stopped threads, with their forks and subagents, to keep per project. A family with more threads than this is skipped.",
      ),
    ),
    baseDir: Flag.String("base-dir").pipe(
      Flag.optional,
      Flag.withDescription("Isolated .t2 directory. Defaults to the current worktree's .t2."),
    ),
    source: Flag.String("source").pipe(
      Flag.optional,
      Flag.withDescription("Source database. Defaults to ~/.t2/userdata/statev2.sqlite."),
    ),
  },
  ({ projects, threadsPerProject, baseDir, source }) =>
    Effect.gen(function* () {
      const result = yield* runMigrateDevDb({
        projects,
        threadsPerProject,
        baseDir: Option.getOrUndefined(baseDir),
        source: Option.getOrUndefined(source),
      });
      yield* Console.log("");
      yield* Console.log(
        `Dev database ready: ${result.databasePath} (${formatSize(result.sizeBytes)})`,
      );
      for (const project of result.projects) {
        yield* Console.log(`  ${project.title}: ${project.threads} threads`);
      }
      yield* Console.log(`  ${result.eventCount} orchestration events kept`);
      yield* Console.log(
        result.executedMigrations.length === 0
          ? "  Migrations: already current (no new migrations in this checkout)"
          : `  Migrations applied: ${result.executedMigrations.join(", ")}`,
      );
    }),
).pipe(
  Command.withDescription(
    "Rebuild the worktree dev database from a pruned snapshot of the real ~/.t2 data, then run migrations.",
  ),
);

if (import.meta.main) {
  Command.run(migrateDevDbCommand, { version: "0.0.0" }).pipe(
    Effect.provide(SpacesDatabaseTools.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    NodeRuntime.runMain,
  );
}
