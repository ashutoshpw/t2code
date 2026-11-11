import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Drain from "../databases/computed/Drain.ts";
import { processZone } from "../databases/computed/Zone.ts";
import * as DatabaseStore from "../databases/DatabaseStore.ts";
import * as Liveness from "../databases/Liveness.ts";
import { makeContext } from "../databases/query/Dates.ts";
import * as Query from "../databases/query/Run.ts";
import * as RowStore from "../databases/RowStore.ts";
import * as SchemaStore from "../databases/SchemaStore.ts";
import { dbError, trashed } from "../databases/Types.ts";
import * as ViewStore from "../databases/ViewStore.ts";
import { wireDataSource, wireDatabase } from "../databases/Wire.ts";
import { byteLength, canonical, ensureLimit, limits } from "../CorePolicy.ts";
import * as PageStore from "../PageStore.ts";
import * as SpacesSql from "../SpacesSql.ts";
import { cursorFor, cursorFrom, isServiceError, strict, validateRaw } from "./Helpers.ts";
import type { DatabaseRecord } from "../databases/Types.ts";
import type { Runtime } from "./Runtime.ts";

const decodeList = Schema.decodeUnknownEffect(C.SpaceDatabaseListInput, strict);
const decodeGet = Schema.decodeUnknownEffect(C.SpaceDatabaseGetInput, strict);
const decodeRow = Schema.decodeUnknownEffect(C.SpaceDatabaseRowGetInput, strict);
const decodeQuery = Schema.decodeUnknownEffect(C.SpaceDatabaseQueryInput, strict);

const decoded = <A>(raw: unknown, decode: (value: unknown) => Effect.Effect<A, unknown>) =>
  validateRaw(raw).pipe(
    Effect.flatMap(decode),
    Effect.mapError((e) =>
      isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
    ),
  );

export const make = (rt: Runtime) => {
  const { admit, checkEnvironment, read, readWithAdmission } = rt;
  const listDatabases = Effect.fn("SpacesService.listDatabases")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* decoded(raw, decodeList);
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* readWithAdmission(environmentId, (meta, admission) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        const limit = input.limit ?? limits.maxListRows;
        yield* ensureLimit("maxListRows", limit);
        const filter = canonical({ spaceId: input.spaceId ?? null });
        const cursor = yield* cursorFrom(
          input.cursor,
          environmentId,
          "listDatabases",
          filter,
          meta.catalog_revision,
        );
        let after = cursor ? { created: cursor.key, id: cursor.id } : undefined;
        const items: C.SpaceDatabaseListResult["items"][number][] = [];
        const inSpace = input.spaceId === undefined ? sql`` : sql`AND space_id = ${input.spaceId}`;
        const window = (from: typeof after) =>
          from === undefined
            ? sql``
            : sql`AND (created_at, database_id) > (${from.created}, ${from.id})`;
        // Dead databases are skipped, so keep pulling bounded batches until the window is full.
        let exhausted = false;
        for (let batch = 0; batch < 8 && items.length < limit && !exhausted; batch++) {
          const rows =
            yield* sql<DatabaseRecord>`SELECT * FROM spaces_db_databases WHERE 1 = 1 ${inSpace}
            ${window(after)} ORDER BY created_at, database_id LIMIT 50`;
          exhausted = rows.length < 50;
          for (const row of rows) {
            after = { created: row.created_at, id: row.database_id };
            if (!(yield* Liveness.databaseLive(row.database_id))) continue;
            const sources = yield* DatabaseStore.sourcesOf(row.database_id);
            items.push({
              database: yield* wireDatabase(row),
              dataSources: sources.map((source) => ({
                id: source.data_source_id,
                name: source.name,
              })),
            });
            if (items.length === limit) {
              exhausted = false;
              break;
            }
          }
        }
        if (after !== undefined && !exhausted) {
          const [further] =
            yield* sql`SELECT 1 FROM spaces_db_databases WHERE 1 = 1 ${inSpace} ${window(after)} LIMIT 1`;
          exhausted = further === undefined;
        }
        let take = items.length;
        while (true) {
          const point =
            take < items.length
              ? { created: items[take - 1]!.database.createdAt, id: items[take - 1]!.database.id }
              : exhausted
                ? undefined
                : after;
          const result: C.SpaceDatabaseListResult = {
            items: items.slice(0, take),
            nextCursor: point
              ? yield* cursorFor(
                  environmentId,
                  "listDatabases",
                  filter,
                  meta.catalog_revision,
                  point.created,
                  point.id,
                )
              : null,
            mutationAdmission: admission,
          };
          const size = byteLength(result);
          if (size <= limits.maxListResponseBytes) return result;
          if (take <= 1) yield* ensureLimit("maxListResponseBytes", size);
          take--;
        }
      }),
    );
  });
  const getDatabase = Effect.fn("SpacesService.getDatabase")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* decoded(raw, decodeGet);
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* readWithAdmission(environmentId, (_meta, admission) =>
      Effect.gen(function* () {
        const record = yield* DatabaseStore.getDatabase(input.databaseId);
        const sources = yield* DatabaseStore.sourcesOf(record.database_id);
        const dataSources = [];
        for (const source of sources)
          dataSources.push(yield* wireDataSource(yield* SchemaStore.load(source.data_source_id)));
        const views = (yield* ViewStore.viewsOfDatabase(record.database_id)).map(
          ViewStore.wireView,
        );
        const result: C.SpaceDatabaseGetResult = {
          database: yield* wireDatabase(record),
          dataSources,
          views,
          mutationAdmission: admission,
        };
        return result;
      }),
    );
  });
  const getDatabaseRows = Effect.fn("SpacesService.getDatabaseRow")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* decoded(raw, decodeRow);
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* readWithAdmission(environmentId, (meta, admission) =>
      Effect.gen(function* () {
        const timeZone = input.timeZone ?? processZone;
        yield* makeContext(meta.observed_time_ms, timeZone, undefined);
        const page = yield* PageStore.load(input.pageId);
        if (page.data_source_id === null) return yield* dbError("not_a_row");
        if (page.trash_batch_id !== null) return yield* trashed();
        const source = yield* DatabaseStore.getLiveDataSource(page.data_source_id);
        const snapshot = yield* SchemaStore.load(source.data_source_id);
        const { rows, related } = yield* RowStore.hydrate(snapshot, [page], input.properties, {
          nowMs: meta.observed_time_ms,
          timeZone,
        });
        const result: C.SpaceDatabaseRowGetResult = {
          row: rows[0]!,
          template: page.row_template === 1,
          dataSource: {
            id: source.data_source_id,
            databaseId: source.database_id,
            schemaRevision: source.schema_revision,
            dataRevision: source.data_revision,
          },
          relatedPages: related,
          ...((yield* Drain.pending(source.data_source_id)) ? { computedPending: true } : {}),
          mutationAdmission: admission,
        };
        return result;
      }),
    );
  });
  const queryDatabase = Effect.fn("SpacesService.queryDatabase")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const request = yield* decoded(raw, decodeQuery);
    yield* checkEnvironment(environmentId, request.environmentId);
    return yield* read(environmentId, (meta) =>
      Query.run({ request, environmentId, nowMs: meta.observed_time_ms }),
    );
  });
  return { listDatabases, getDatabase, queryDatabase, getDatabaseRows };
};
