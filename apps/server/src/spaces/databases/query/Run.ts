import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { byteLength, ensureDatabaseLimit } from "../../CorePolicy.ts";
import * as SpacesSql from "../../SpacesSql.ts";
import * as DatabaseStore from "../DatabaseStore.ts";
import * as SchemaStore from "../SchemaStore.ts";
import { dbError } from "../Types.ts";
import * as ViewStore from "../ViewStore.ts";
import { type QueryDefinitionInput, effective } from "./Definition.ts";
import * as Aggregates from "./Aggregates.ts";
import * as Cursor from "./Cursor.ts";
import { makeContext } from "./Dates.ts";
import { groups } from "./Groups.ts";
import { makePlan } from "./Plan.ts";
import * as Rows from "./Rows.ts";

const DEFAULT_LIMIT = 50;

/** Runs a view or an ad hoc query (section 3.8): one data source, one read transaction. */
export const run = Effect.fn("SpacesDatabases.query")(function* (input: {
  readonly request: C.SpaceDatabaseQueryInput;
  readonly environmentId: string;
  readonly nowMs: number;
}) {
  const { request, environmentId } = input;
  const sql = yield* SpacesSql.SpacesSql;
  const source = yield* DatabaseStore.getLiveDataSource(request.dataSourceId);
  const snapshot = yield* SchemaStore.load(source.data_source_id);
  const view = request.viewId === undefined ? undefined : yield* ViewStore.getView(request.viewId);
  if (view && view.data_source_id !== source.data_source_id) return yield* dbError("invalid_view");
  const dates = yield* makeContext(input.nowMs, request.timeZone, request.weekStart);
  const definition: QueryDefinitionInput = {
    view,
    filter: request.filter,
    extraFilter: request.extraFilter,
    sorts: request.sorts,
    group: request.group,
    subGroup: request.subGroup,
    search: request.search,
    aggregates: request.aggregates,
    includeAggregates: request.include?.aggregates === true,
    properties: request.properties,
    scope: request.scope,
    mode: request.mode,
  };
  const e = yield* effective(snapshot, definition);
  const c = { sql, snapshot, dates };
  const plan = yield* makePlan({
    c,
    e,
    environmentId,
    dataRevision: source.data_revision,
  });
  const base = {
    dataSourceId: source.data_source_id,
    schemaRevision: source.schema_revision,
    dataRevision: source.data_revision,
  };
  const wantTotal = request.include?.total === true;
  const wantAggregates = request.include?.aggregates === true && e.aggregates.length > 0;

  if (request.mode === "groups") {
    const rowsPerGroup = request.rowsPerGroup ?? 0;
    yield* ensureDatabaseLimit("maxGroupPreviewRows", rowsPerGroup);
    const result = yield* groups(plan, { rowsPerGroup, aggregates: wantAggregates });
    return {
      ...base,
      rows: [],
      groups: result.groups,
      ...(result.truncated ? { groupsTruncated: true } : {}),
      ...(wantTotal ? { total: result.total } : {}),
      ...(result.aggregates ? { aggregates: result.aggregates } : {}),
      relatedPages: result.related,
      nextCursor: null,
    } satisfies C.SpaceDatabaseQueryResult;
  }

  const limit = request.limit ?? DEFAULT_LIMIT;
  yield* ensureDatabaseLimit("maxQueryRows", limit);
  const after =
    request.cursor === undefined
      ? undefined
      : yield* Cursor.decode(
          request.cursor,
          environmentId,
          plan.print,
          plan.keys.length,
          source.data_revision,
        );
  const total = wantTotal ? yield* Rows.total(plan) : undefined;
  const aggregates = wantAggregates
    ? yield* Effect.gen(function* () {
        const totalOf = new Map([
          [Aggregates.bucketId(null, null), total ?? (yield* Rows.total(plan))],
        ]);
        return (yield* Aggregates.aggregates(plan, 0, e.aggregates, totalOf))(
          Aggregates.bucketId(null, null),
        );
      })
    : undefined;
  const page = yield* Rows.page(
    plan,
    limit,
    after,
    byteLength({
      ...(total === undefined ? {} : { total }),
      ...(aggregates ? { aggregates } : {}),
    }),
  );
  return {
    ...base,
    rows: page.rows,
    ...(total === undefined ? {} : { total }),
    ...(aggregates === undefined ? {} : { aggregates }),
    relatedPages: page.related,
    nextCursor: page.nextCursor,
  } satisfies C.SpaceDatabaseQueryResult;
});
