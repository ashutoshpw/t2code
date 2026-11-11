import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { boot, env } from "./Spaces.testkit.ts";

type Service = Effect.Success<ReturnType<typeof boot>>["service"];
type Common = Effect.Success<ReturnType<typeof boot>>["common"];

/** Mutation helpers over a booted fixture; every call gets a fresh mutation id. */
export const databaseKit = (service: Service, common: Common, spaceId: C.SpaceId) => {
  let counter = 0;
  const next = (label: string) => C.SpaceMutationId.make(`${label}-${++counter}`);
  const create = Effect.fn("DatabasesTestkit.create")(function* (
    title: string,
    options: {
      readonly properties?: readonly C.SpacePropertyDraft[];
      readonly appendToPageId?: C.SpacePageId;
    } = {},
  ) {
    return yield* service.createDatabase({
      ...common,
      mutationId: next("create-database"),
      spaceId,
      title,
      ...(options.properties ? { properties: options.properties } : {}),
      ...(options.appendToPageId ? { appendToPageId: options.appendToPageId } : {}),
    });
  });
  const schema = Effect.fn("DatabasesTestkit.schema")(function* (
    dataSourceId: C.SpaceDataSourceId,
    operations: readonly C.SpaceSchemaOperation[],
  ) {
    return yield* service.updateSchema({
      ...common,
      mutationId: next("schema"),
      dataSourceId,
      operations,
    });
  });
  const addRows = Effect.fn("DatabasesTestkit.addRows")(function* (
    dataSourceId: C.SpaceDataSourceId,
    rows: readonly C.SpaceRowDraft[],
    beforeRowId?: C.SpacePageId,
  ) {
    return yield* service.createRows({
      ...common,
      mutationId: next("rows"),
      dataSourceId,
      rows,
      ...(beforeRowId ? { beforeRowId } : {}),
    });
  });
  const setCells = Effect.fn("DatabasesTestkit.setCells")(function* (
    dataSourceId: C.SpaceDataSourceId,
    pageId: C.SpacePageId,
    cells: Record<string, C.SpaceCellValue | null>,
  ) {
    return yield* service.updateRows({
      ...common,
      mutationId: next("cells"),
      dataSourceId,
      rows: [{ pageId, cells }],
    });
  });
  const row = Effect.fn("DatabasesTestkit.row")(function* (
    pageId: C.SpacePageId,
    properties?: readonly C.SpacePropertyId[],
  ) {
    return yield* service.getDatabaseRows({
      ...env,
      pageId,
      ...(properties ? { properties } : {}),
    });
  });
  const get = (databaseId: C.SpaceDatabaseId) => service.getDatabase({ ...env, databaseId });
  return { next, create, schema, addRows, setCells, row, get, common, service };
};

export const pid = C.SpacePropertyId.make;
export const oid = C.SpaceOptionId.make;

/** Reads rows straight from the Spaces database file, bypassing the service. */
export const raw = <A, E>(dbPath: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));

export const cellRows = (dbPath: string, pageId: string, propertyId: string) =>
  raw(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{
        readonly ord: number;
        readonly ref: string | null;
        readonly num: number | null;
        readonly text_key: string | null;
      }>`SELECT ord, ref, num, text_key FROM spaces_db_cells WHERE page_id = ${pageId} AND property_id = ${propertyId} ORDER BY ord`;
    }),
  );

/** Runs SQL against the Spaces database file with a second writer; the service must be idle. */
export const exec = <A, E>(dbPath: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

const unexpected = (wanted: string, error: C.SpaceServiceError) =>
  Effect.die(`Expected ${wanted}, got ${error._tag}`);
const succeeded = (wanted: string) => Effect.die(`Expected ${wanted}, but the call succeeded`);

export const databaseError = <A>(effect: Effect.Effect<A, C.SpaceServiceError>) =>
  Effect.matchEffect(effect, {
    onFailure: (error) =>
      error._tag === "SpaceDatabaseError"
        ? Effect.succeed(error)
        : unexpected("SpaceDatabaseError", error),
    onSuccess: () => succeeded("SpaceDatabaseError"),
  });

export const limitError = <A>(effect: Effect.Effect<A, C.SpaceServiceError>) =>
  Effect.matchEffect(effect, {
    onFailure: (error) =>
      error._tag === "SpaceLimitExceededError"
        ? Effect.succeed(error.limit)
        : unexpected("SpaceLimitExceededError", error),
    onSuccess: () => succeeded("SpaceLimitExceededError"),
  });

export const validationReason = <A>(effect: Effect.Effect<A, C.SpaceServiceError>) =>
  Effect.matchEffect(effect, {
    onFailure: (error) =>
      error._tag === "SpaceValidationError"
        ? Effect.succeed(error.reason)
        : unexpected("SpaceValidationError", error),
    onSuccess: () => succeeded("SpaceValidationError"),
  });

/** The search index builds on writes; one throwaway search lets the next one see it ready. */
export const warmSearch = (service: Service) =>
  Effect.ignore(service.search({ ...env, query: "warmup" }));

/** Row titles of a data source in manual order. */
export const rowOrder = (dbPath: string, dataSourceId: string) =>
  raw(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly title: string;
      }>`SELECT title FROM spaces_pages WHERE data_source_id = ${dataSourceId} ORDER BY row_position, row_seq`;
      return rows.map((row) => row.title);
    }),
  );
