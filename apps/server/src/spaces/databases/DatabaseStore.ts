import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { ensureDatabaseLimit } from "../CorePolicy.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as Changes from "./Changes.ts";
import * as Ids from "./Ids.ts";
import * as Liveness from "./Liveness.ts";
import { appendPosition } from "./Position.ts";
import { type DataSourceRecord, type DatabaseRecord, notFound } from "./Types.ts";

export const getDatabase = Effect.fn("SpacesDatabases.getDatabase")(function* (id: string) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] =
    yield* sql<DatabaseRecord>`SELECT * FROM spaces_db_databases WHERE database_id = ${id}`;
  if (!row) return yield* notFound("database", id);
  return row;
});

export const getDataSource = Effect.fn("SpacesDatabases.getDataSource")(function* (id: string) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] =
    yield* sql<DataSourceRecord>`SELECT * FROM spaces_db_data_sources WHERE data_source_id = ${id}`;
  if (!row) return yield* notFound("data_source", id);
  return row;
});

/** A data source whose database is live; dead ones fail like a trashed page. */
export const getLiveDataSource = Effect.fn("SpacesDatabases.getLiveDataSource")(function* (
  id: string,
) {
  const source = yield* getDataSource(id);
  yield* Liveness.assertDatabaseLive(source.database_id);
  return source;
});

export const getLiveDatabase = Effect.fn("SpacesDatabases.getLiveDatabase")(function* (id: string) {
  const database = yield* getDatabase(id);
  yield* Liveness.assertDatabaseLive(id);
  return database;
});

export const sourcesOf = Effect.fn("SpacesDatabases.sourcesOf")(function* (databaseId: string) {
  const sql = yield* SpacesSql.SpacesSql;
  return yield* sql<DataSourceRecord>`SELECT * FROM spaces_db_data_sources WHERE database_id = ${databaseId}
    ORDER BY position, data_source_id`;
});

/** Any change to the database record, its data sources or its views bumps the revision. */
export const touchDatabase = Effect.fn("SpacesDatabases.touchDatabase")(function* (
  id: string,
  now: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_db_databases SET revision = revision + 1, updated_at = ${now} WHERE database_id = ${id}`;
  yield* Changes.recordDatabase(id);
  const [row] = yield* sql<{
    readonly revision: number;
  }>`SELECT revision FROM spaces_db_databases WHERE database_id = ${id}`;
  return row!.revision;
});

export const bumpSchema = Effect.fn("SpacesDatabases.bumpSchema")(function* (
  id: string,
  now: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_db_data_sources SET schema_revision = schema_revision + 1, updated_at = ${now} WHERE data_source_id = ${id}`;
  yield* Changes.recordDataSource(id);
});

export const bumpData = Effect.fn("SpacesDatabases.bumpData")(function* (id: string, now: string) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_db_data_sources SET data_revision = data_revision + 1, updated_at = ${now} WHERE data_source_id = ${id}`;
  yield* Changes.recordDataSource(id);
});

export const validName = Effect.fn("SpacesDatabases.validName")(function* (name: string) {
  const trimmed = name.trim();
  if (trimmed.length === 0) return yield* new C.SpaceValidationError({ reason: "invalid_input" });
  yield* ensureDatabaseLimit("maxNameBytes", Buffer.byteLength(trimmed, "utf8"));
  return trimmed;
});

export const insertDatabase = Effect.fn("SpacesDatabases.insertDatabase")(function* (input: {
  readonly spaceId: C.SpaceId;
  readonly title: string;
  readonly icon: string | null;
  readonly now: string;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  const id = C.SpaceDatabaseId.make(yield* Ids.register("database"));
  yield* sql`INSERT INTO spaces_db_databases (database_id, space_id, title, icon, created_at, updated_at)
    VALUES (${id}, ${input.spaceId}, ${input.title}, ${input.icon}, ${input.now}, ${input.now})`;
  return id;
});

export const insertDataSource = Effect.fn("SpacesDatabases.insertDataSource")(function* (input: {
  readonly databaseId: string;
  readonly name: string;
  readonly now: string;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  const existing = yield* sourcesOf(input.databaseId);
  yield* ensureDatabaseLimit("maxDataSourcesPerDatabase", existing.length + 1);
  const id = C.SpaceDataSourceId.make(yield* Ids.register("data_source"));
  const last = existing[existing.length - 1];
  yield* sql`INSERT INTO spaces_db_data_sources (data_source_id, database_id, name, position, created_at, updated_at)
    VALUES (${id}, ${input.databaseId}, ${input.name}, ${appendPosition(last?.position ?? null)}, ${input.now}, ${input.now})`;
  return id;
});
