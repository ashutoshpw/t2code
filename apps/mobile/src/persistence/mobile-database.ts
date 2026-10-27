import type { EnvironmentId } from "@t2code/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  decodeSpaceDocumentDraft,
  spaceDraftMaxBytes,
  type SpaceDocumentDraft,
} from "@t2code/client-runtime/spaces";
import { SpacePageTarget } from "@t2code/contracts/spaces";

const DATABASE_NAME = "t2code-client.db";
const DATABASE_SCHEMA_VERSION = 2;
const SPACE_DRAFT_TOTAL_BYTES = 16 * 1024 * 1024;
const SPACE_DRAFT_MAX_ROWS = 128;
const decodeDraftKey = Schema.decodeUnknownSync(SpacePageTarget, { onExcessProperty: "error" });
const LEGACY_CACHE_DIRECTORIES = [
  "connection-shell-snapshots",
  "shell-snapshots",
  "connection-thread-snapshots",
  "connection-server-configs",
  "connection-vcs-refs",
] as const;

export const ClientCacheKind = Schema.Literals([
  "shell",
  "thread",
  "server-config",
  "vcs-refs",
  "project-favicon",
  "pull-request",
]);
export type ClientCacheKind = typeof ClientCacheKind.Type;

export interface ClientCacheSummaryRow {
  readonly environmentId: EnvironmentId;
  readonly kind: ClientCacheKind;
  readonly recordCount: number;
  readonly payloadBytes: number;
}

export interface StoredPreferencesJson {
  readonly payload: string;
  readonly updatedAt: number;
}

const ClientCacheSummaryRows = Schema.Array(
  Schema.Struct({
    environmentId: Schema.String,
    kind: ClientCacheKind,
    recordCount: Schema.Number,
    payloadBytes: Schema.Number,
  }),
);

const MobileDatabaseOperation = Schema.Literals([
  "open",
  "migrate",
  "load-cache",
  "list-cache",
  "save-cache",
  "remove-cache",
  "clear-cache-kind",
  "clear-environment-cache",
  "clear-all-caches",
  "inspect-caches",
  "load-preferences",
  "save-preferences",
  "load-space-draft",
  "write-space-draft",
]);

export class MobileDatabaseError extends Schema.TaggedError<MobileDatabaseError>()(
  "MobileDatabaseError",
  {
    operation: MobileDatabaseOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mobile database operation failed: ${this.operation}.`;
  }
}

function databaseError(operation: typeof MobileDatabaseOperation.Type) {
  return (cause: unknown) => new MobileDatabaseError({ operation, cause });
}

function draftKey(key: SpacePageTarget) {
  const checked = decodeDraftKey(key);
  if (Object.values(checked).some((value) => new TextEncoder().encode(value).byteLength > 256))
    throw new Error("Spaces draft identity exceeds the storage limit");
  return checked;
}

async function readSpaceDraft(database: SQLiteDatabase, key: SpacePageTarget) {
  const row = await database.getFirstAsync<{
    readonly schemaVersion: number;
    readonly payloadBytes: number;
    readonly actualBytes: number;
    readonly payload: string | null;
  }>(
    `SELECT schema_version AS schemaVersion, payload_bytes AS payloadBytes,
       LENGTH(CAST(payload AS BLOB)) AS actualBytes,
       CASE WHEN LENGTH(CAST(payload AS BLOB)) <= ? THEN payload END AS payload
     FROM spaces_page_drafts WHERE environment_id = ? AND page_id = ?`,
    spaceDraftMaxBytes,
    key.environmentId,
    key.pageId,
  );
  if (row === null) return null;
  if (
    row.schemaVersion !== 1 ||
    row.actualBytes !== row.payloadBytes ||
    row.actualBytes > spaceDraftMaxBytes ||
    typeof row.payload !== "string"
  )
    throw new Error("Invalid Spaces draft; stored data has been retained");
  return { draft: decodeSpaceDocumentDraft(JSON.parse(row.payload), key), bytes: row.actualBytes };
}

interface LegacyCacheRecord {
  readonly environmentId: string;
  readonly kind: ClientCacheKind;
  readonly cacheKey: string;
  readonly schemaVersion: number;
  readonly payload: string;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function decodeLegacyCacheRecord(
  directoryName: (typeof LEGACY_CACHE_DIRECTORIES)[number],
  payload: string,
): LegacyCacheRecord | null {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = objectRecord(JSON.parse(payload));
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed.environmentId !== "string" ||
    typeof parsed.schemaVersion !== "number"
  ) {
    return null;
  }

  switch (directoryName) {
    case "connection-shell-snapshots":
    case "shell-snapshots":
      return {
        environmentId: parsed.environmentId,
        kind: "shell",
        cacheKey: "snapshot",
        schemaVersion: parsed.schemaVersion,
        payload,
      };
    case "connection-thread-snapshots":
      return typeof parsed.threadId === "string"
        ? {
            environmentId: parsed.environmentId,
            kind: "thread",
            cacheKey: parsed.threadId,
            schemaVersion: parsed.schemaVersion,
            payload,
          }
        : null;
    case "connection-server-configs":
      return {
        environmentId: parsed.environmentId,
        kind: "server-config",
        cacheKey: "config",
        schemaVersion: parsed.schemaVersion,
        payload,
      };
    case "connection-vcs-refs":
      return typeof parsed.cwd === "string"
        ? {
            environmentId: parsed.environmentId,
            kind: "vcs-refs",
            cacheKey: parsed.cwd,
            schemaVersion: parsed.schemaVersion,
            payload,
          }
        : null;
  }
}

async function migrateLegacyFileCaches(database: SQLiteDatabase): Promise<boolean> {
  try {
    const { Directory, File, Paths } = await import("expo-file-system");
    let complete = true;
    const listFiles = (
      directory: InstanceType<typeof Directory>,
    ): Array<InstanceType<typeof File>> =>
      directory.list().flatMap((entry) => (entry instanceof File ? [entry] : listFiles(entry)));

    for (const directoryName of LEGACY_CACHE_DIRECTORIES) {
      try {
        const directory = new Directory(Paths.document, directoryName);
        if (!directory.exists) continue;
        for (const file of listFiles(directory)) {
          const payload = await file.text();
          const record = decodeLegacyCacheRecord(directoryName, payload);
          if (record === null) continue;
          await database.runAsync(
            `INSERT INTO client_cache
              (environment_id, kind, cache_key, schema_version, payload, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (environment_id, kind, cache_key) DO NOTHING`,
            record.environmentId,
            record.kind,
            record.cacheKey,
            record.schemaVersion,
            record.payload,
            Date.now(),
          );
        }
        directory.delete();
      } catch (cause) {
        complete = false;
        console.warn(`[mobile-database] could not migrate legacy cache ${directoryName}`, cause);
      }
    }
    return complete;
  } catch (cause) {
    console.warn("[mobile-database] could not load legacy cache migration", cause);
    return false;
  }
}

export class MobileDatabase extends Context.Service<
  MobileDatabase,
  {
    readonly loadSpacePageDraft: (
      key: SpacePageTarget,
    ) => Effect.Effect<SpaceDocumentDraft | null, MobileDatabaseError>;
    readonly writeSpacePageDraft: (
      key: SpacePageTarget,
      draft: SpaceDocumentDraft | null,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly loadCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
    ) => Effect.Effect<Option.Option<string>, MobileDatabaseError>;
    readonly listCache: (
      kind: ClientCacheKind,
    ) => Effect.Effect<ReadonlyArray<string>, MobileDatabaseError>;
    readonly saveCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
      schemaVersion: number,
      payload: string,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly removeCache: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
      cacheKey: string,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly clearCacheKind: (
      environmentId: EnvironmentId,
      kind: ClientCacheKind,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly clearEnvironmentCache: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, MobileDatabaseError>;
    readonly clearAllCaches: Effect.Effect<void, MobileDatabaseError>;
    readonly inspectCaches: Effect.Effect<
      ReadonlyArray<ClientCacheSummaryRow>,
      MobileDatabaseError
    >;
    readonly loadPreferencesJson: Effect.Effect<
      Option.Option<StoredPreferencesJson>,
      MobileDatabaseError
    >;
    readonly savePreferencesJson: (
      payload: string,
      updatedAt: number,
    ) => Effect.Effect<void, MobileDatabaseError>;
  }
>()("@t2code/mobile/persistence/MobileDatabase") {}

const makeAvailable = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const SQLite = await import("expo-sqlite");
        return SQLite.openDatabaseAsync(DATABASE_NAME);
      },
      catch: databaseError("open"),
    }),
    (openDatabase) => Effect.promise(() => openDatabase.closeAsync()).pipe(Effect.ignore),
  );

  yield* Effect.tryPromise({
    try: async () => {
      await database.execAsync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      const schema = await database.getFirstAsync<{ readonly user_version: number }>(
        "PRAGMA user_version",
      );
      if ((schema?.user_version ?? 0) > DATABASE_SCHEMA_VERSION)
        throw new Error("The mobile database was created by a newer app");
      await database.withExclusiveTransactionAsync(async (transaction) => {
        await transaction.execAsync(`
              CREATE TABLE IF NOT EXISTS client_cache (
                environment_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (environment_id, kind, cache_key)
              ) WITHOUT ROWID;

              CREATE INDEX IF NOT EXISTS client_cache_environment_updated
                ON client_cache (environment_id, updated_at DESC);

              CREATE TABLE IF NOT EXISTS client_preferences (
                singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL
              );

              CREATE TABLE IF NOT EXISTS spaces_page_drafts (
                environment_id TEXT NOT NULL,
                page_id TEXT NOT NULL,
                schema_version INTEGER NOT NULL CHECK (schema_version = 1),
                payload TEXT NOT NULL,
                payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 1 AND 2097152),
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (environment_id, page_id),
                CHECK (LENGTH(CAST(payload AS BLOB)) = payload_bytes)
              ) WITHOUT ROWID;
            `);
      });
      if ((schema?.user_version ?? 0) < DATABASE_SCHEMA_VERSION) {
        const migrated =
          (schema?.user_version ?? 0) >= 1 || (await migrateLegacyFileCaches(database));
        if (migrated) await database.execAsync(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};`);
      }
    },
    catch: databaseError("migrate"),
  });

  return MobileDatabase.of({
    loadSpacePageDraft: Effect.fn("MobileDatabase.loadSpacePageDraft")((key) =>
      Effect.tryPromise({
        try: async () => (await readSpaceDraft(database, draftKey(key)))?.draft ?? null,
        catch: databaseError("load-space-draft"),
      }),
    ),
    writeSpacePageDraft: Effect.fn("MobileDatabase.writeSpacePageDraft")((key, draft) =>
      Effect.tryPromise({
        try: async () => {
          const checkedKey = draftKey(key);
          const payload =
            draft === null ? null : JSON.stringify(decodeSpaceDocumentDraft(draft, checkedKey));
          const bytes = payload === null ? 0 : new TextEncoder().encode(payload).byteLength;
          await database.withExclusiveTransactionAsync(async (transaction) => {
            const previous = await readSpaceDraft(transaction, checkedKey);
            if (payload === null) {
              await transaction.runAsync(
                "DELETE FROM spaces_page_drafts WHERE environment_id = ? AND page_id = ?",
                checkedKey.environmentId,
                checkedKey.pageId,
              );
              return;
            }
            const usage = await transaction.getFirstAsync<{
              readonly rows: number;
              readonly bytes: number;
            }>(
              `SELECT COUNT(*) AS rows, COALESCE(SUM(actual_bytes), 0) AS bytes FROM
               (SELECT LENGTH(CAST(payload AS BLOB)) AS actual_bytes FROM spaces_page_drafts LIMIT ?)`,
              SPACE_DRAFT_MAX_ROWS + 1,
            );
            if (
              usage === null ||
              usage.rows + (previous === null ? 1 : 0) > SPACE_DRAFT_MAX_ROWS ||
              usage.bytes - (previous?.bytes ?? 0) + bytes > SPACE_DRAFT_TOTAL_BYTES
            )
              throw new Error("Local Spaces drafts are full; existing drafts have been retained");
            await transaction.runAsync(
              `INSERT INTO spaces_page_drafts (environment_id, page_id, schema_version, payload, payload_bytes, updated_at)
               VALUES (?, ?, 1, ?, ?, ?)
               ON CONFLICT (environment_id, page_id) DO UPDATE SET
                 payload = excluded.payload, payload_bytes = excluded.payload_bytes, updated_at = excluded.updated_at`,
              checkedKey.environmentId,
              checkedKey.pageId,
              payload,
              bytes,
              Date.now(),
            );
          });
        },
        catch: databaseError("write-space-draft"),
      }),
    ),
    loadCache: Effect.fn("MobileDatabase.loadCache")((environmentId, kind, cacheKey) =>
      Effect.tryPromise({
        try: () =>
          database.getFirstAsync<{ readonly payload: string }>(
            `SELECT payload
                     FROM client_cache
                     WHERE environment_id = ? AND kind = ? AND cache_key = ?
                       AND (kind != 'pull-request' OR updated_at >= ?)`,
            environmentId,
            kind,
            cacheKey,
            Date.now() - 30 * 24 * 60 * 60_000,
          ),
        catch: databaseError("load-cache"),
      }).pipe(Effect.map((row) => Option.fromNullishOr(row?.payload))),
    ),
    listCache: Effect.fn("MobileDatabase.listCache")((kind) =>
      Effect.tryPromise({
        try: () =>
          database.getAllAsync<{ readonly payload: string }>(
            "SELECT payload FROM client_cache WHERE kind = ? ORDER BY updated_at",
            kind,
          ),
        catch: databaseError("list-cache"),
      }).pipe(Effect.map((rows) => rows.map((row) => row.payload))),
    ),
    saveCache: Effect.fn("MobileDatabase.saveCache")(
      (environmentId, kind, cacheKey, schemaVersion, payload) =>
        Effect.tryPromise({
          try: async () => {
            // Bound offline PR caches to 32 MiB and 256 responses per environment; reject huge diffs that would evict everything.
            if (
              kind === "pull-request" &&
              new TextEncoder().encode(payload).length > 4 * 1024 * 1024
            )
              return;
            const save = async (transaction: SQLiteDatabase) => {
              await transaction.runAsync(
                `INSERT INTO client_cache
                  (environment_id, kind, cache_key, schema_version, payload, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (environment_id, kind, cache_key) DO UPDATE SET
                   schema_version = excluded.schema_version,
                   payload = excluded.payload,
                   updated_at = excluded.updated_at`,
                environmentId,
                kind,
                cacheKey,
                schemaVersion,
                payload,
                Date.now(),
              );
              if (kind === "pull-request") {
                await transaction.runAsync(
                  `DELETE FROM client_cache WHERE environment_id = ? AND kind = 'pull-request'
                   AND cache_key IN (
                     SELECT cache_key FROM (
                       SELECT cache_key, updated_at,
                         ROW_NUMBER() OVER (ORDER BY updated_at DESC, cache_key) AS position,
                         SUM(LENGTH(CAST(payload AS BLOB))) OVER (
                           ORDER BY updated_at DESC, cache_key
                         ) AS total_bytes
                       FROM client_cache WHERE environment_id = ? AND kind = 'pull-request'
                     ) WHERE position > 256 OR total_bytes > 33554432 OR updated_at < ?
                   )`,
                  environmentId,
                  environmentId,
                  Date.now() - 30 * 24 * 60 * 60_000,
                );
              }
            };
            await save(database);
          },
          catch: databaseError("save-cache"),
        }).pipe(Effect.asVoid),
    ),
    removeCache: Effect.fn("MobileDatabase.removeCache")((environmentId, kind, cacheKey) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            `DELETE FROM client_cache
                     WHERE environment_id = ? AND kind = ? AND cache_key = ?`,
            environmentId,
            kind,
            cacheKey,
          ),
        catch: databaseError("remove-cache"),
      }).pipe(Effect.asVoid),
    ),
    clearCacheKind: Effect.fn("MobileDatabase.clearCacheKind")((environmentId, kind) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            "DELETE FROM client_cache WHERE environment_id = ? AND kind = ?",
            environmentId,
            kind,
          ),
        catch: databaseError("clear-cache-kind"),
      }).pipe(Effect.asVoid),
    ),
    clearEnvironmentCache: Effect.fn("MobileDatabase.clearEnvironmentCache")((environmentId) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync("DELETE FROM client_cache WHERE environment_id = ?", environmentId),
        catch: databaseError("clear-environment-cache"),
      }).pipe(Effect.asVoid),
    ),
    clearAllCaches: Effect.tryPromise({
      try: () => database.runAsync("DELETE FROM client_cache"),
      catch: databaseError("clear-all-caches"),
    }).pipe(Effect.asVoid),
    inspectCaches: Effect.tryPromise({
      try: () =>
        database.getAllAsync<unknown>(`
                SELECT
                  environment_id AS environmentId,
                  kind,
                  COUNT(*) AS recordCount,
                  COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS payloadBytes
                FROM client_cache
                GROUP BY environment_id, kind
                ORDER BY environment_id, kind
              `),
      catch: databaseError("inspect-caches"),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ClientCacheSummaryRows)),
      Effect.mapError(databaseError("inspect-caches")),
      Effect.map((rows): ReadonlyArray<ClientCacheSummaryRow> =>
        rows.map((row) => ({
          environmentId: row.environmentId as EnvironmentId,
          kind: row.kind,
          recordCount: row.recordCount,
          payloadBytes: row.payloadBytes,
        })),
      ),
    ),
    loadPreferencesJson: Effect.tryPromise({
      try: () =>
        database.getFirstAsync<StoredPreferencesJson>(
          `SELECT payload, updated_at AS updatedAt
                 FROM client_preferences
                 WHERE singleton = 1`,
        ),
      catch: databaseError("load-preferences"),
    }).pipe(Effect.map(Option.fromNullishOr)),
    savePreferencesJson: Effect.fn("MobileDatabase.savePreferencesJson")((payload, updatedAt) =>
      Effect.tryPromise({
        try: () =>
          database.runAsync(
            `INSERT INTO client_preferences (singleton, payload, updated_at)
                   VALUES (1, ?, ?)
                   ON CONFLICT (singleton) DO UPDATE SET
                     payload = excluded.payload,
                     updated_at = excluded.updated_at`,
            payload,
            updatedAt,
          ),
        catch: databaseError("save-preferences"),
      }).pipe(Effect.asVoid),
    ),
  });
});

function makeUnavailable(error: MobileDatabaseError): MobileDatabase["Service"] {
  const fail = Effect.fail(error);
  return MobileDatabase.of({
    loadSpacePageDraft: () => fail,
    writeSpacePageDraft: () => fail,
    loadCache: () => fail,
    listCache: () => fail,
    saveCache: () => fail,
    removeCache: () => fail,
    clearCacheKind: () => fail,
    clearEnvironmentCache: () => fail,
    clearAllCaches: fail,
    inspectCaches: fail,
    loadPreferencesJson: fail,
    savePreferencesJson: () => fail,
  });
}

export const make = Effect.result(makeAvailable).pipe(
  Effect.map((result) =>
    result._tag === "Success" ? result.success : makeUnavailable(result.failure),
  ),
);

export const layer = Layer.effect(MobileDatabase, make);
