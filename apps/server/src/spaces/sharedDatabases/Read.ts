import type {
  EnvironmentId,
  SpaceSharedDatabase,
  SpaceSharedDatabaseRow,
  SpaceSharedDatabaseRowPage,
  SpaceSharedDatabaseWindow,
} from "@t2code/contracts";
import {
  SPACE_SHARED_DATABASE_GROUP_ROWS,
  SPACE_SHARED_DATABASE_RANGE_DAYS,
  SPACE_SHARED_DATABASE_WINDOW_ROWS,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { canonical } from "../CorePolicy.ts";
import { processZone } from "../databases/computed/Zone.ts";
import { isObject, parseJson } from "../databases/Json.ts";
import { makeContext } from "../databases/query/Dates.ts";
import { exactKey } from "../databases/query/Group.ts";
import * as Query from "../databases/query/Run.ts";
import * as Rows from "../databases/query/Rows.ts";
import * as RowStore from "../databases/RowStore.ts";
import { notFound } from "../databases/Types.ts";
import * as PageShares from "../PageShares.ts";
import * as SpacesSql from "../SpacesSql.ts";
import {
  optionLedger,
  sanitizeProperty,
  sanitizeRelated,
  sanitizeRow,
  sanitizeView,
  sanitizeWindow,
  shownProperties,
} from "./Sanitize.ts";
import { type ScopeCache, type ViewScope, loadView, resolveBlock, resolveView } from "./Scope.ts";

export interface QueryParams {
  readonly group?: string;
  readonly from?: string;
  readonly to?: string;
  /** The raw query cursor, already opened by the caller. */
  readonly cursor?: string;
  readonly timeZone?: string;
}

/** A well-formed request that does not fit the view it names is `bad`; anything else is a refusal. */
export type QueryOutcome =
  | { readonly _tag: "Window"; readonly window: SpaceSharedDatabaseWindow }
  | { readonly _tag: "Bad" };

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const decodeGroupKey = Schema.decodeUnknownOption(C.SpaceKnownGroupKey, {
  onExcessProperty: "error",
});
const groupKeyOf = (text: string) => {
  try {
    return decodeGroupKey(parseJson(text));
  } catch {
    return Option.none<C.SpaceKnownGroupKey>();
  }
};
const decodeCursor = Schema.decodeUnknownOption(C.SpaceCursor);

/** Days since 1970-01-01 of a real calendar day, else null. */
const dayNumber = (day: string): number | null => {
  const match = DAY_PATTERN.exec(day);
  if (match === null) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || date < 1 || date > lengths[month - 1]!) return null;
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + date - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

const resolveZone = Effect.fn("SharedDatabases.resolveZone")(function* (
  nowMs: number,
  requested: string | undefined,
) {
  if (requested === undefined) return processZone;
  const accepted = yield* makeContext(nowMs, requested, undefined).pipe(Effect.option);
  return Option.isSome(accepted) ? requested : processZone;
});

const requestBase = (
  scope: ViewScope,
  environmentId: EnvironmentId,
  timeZone: string,
  properties: readonly string[],
) => {
  const preview = scope.shape.layout.cardPreview;
  const cards = scope.shape.type === "board" || scope.shape.type === "gallery";
  const cover =
    cards &&
    isObject(preview) &&
    (preview.kind === "page_cover" || preview.kind === "page_content");
  return {
    environmentId: environmentId,
    dataSourceId: scope.source.data_source_id,
    viewId: scope.view.view_id,
    properties: properties.map((id) => C.SpacePropertyId.make(id)),
    timeZone,
    subGroup: null,
    ...(cover ? { include: { cover: true } } : {}),
  } as const;
};

export const describe = Effect.fn("SharedDatabases.describe")(function* (
  rootPageId: C.SpacePageId,
  pageId: C.SpacePageId,
  blockId: string,
) {
  const block = yield* resolveBlock(rootPageId, pageId, blockId);
  const cache: ScopeCache = new Map();
  const scopes: ViewScope[] = [];
  for (const id of block.viewIds) {
    const scope = yield* loadView(block, id, cache).pipe(
      Effect.catchTags({ SpaceNotFoundError: () => Effect.succeed(null) }),
    );
    if (scope !== null) scopes.push(scope);
  }
  const dataSources = new Map<string, { name: string; shown: Set<string>; scope: ViewScope }>();
  for (const scope of scopes) {
    const entry = dataSources.get(scope.source.data_source_id) ?? {
      name: scope.source.name,
      shown: new Set<string>(),
      scope,
    };
    for (const id of shownProperties(scope)) entry.shown.add(id);
    dataSources.set(scope.source.data_source_id, entry);
  }
  const { database } = block;
  return {
    database: {
      id: database.database_id,
      title: database.title,
      ...(database.icon === null ? {} : { icon: database.icon }),
    },
    dataSources: [...dataSources].map(([id, entry]) => ({
      id: C.SpaceDataSourceId.make(id),
      name: entry.name,
      properties: Object.fromEntries(
        entry.scope.snapshot.live
          .filter((property) => entry.shown.has(property.id))
          .map((property) => [property.id, sanitizeProperty(property)]),
      ),
    })),
    views: scopes.map(sanitizeView),
  } satisfies SpaceSharedDatabase;
});

/** The overlap filter of a calendar or timeline window, as the signed-in views build it. */
const overlap = (scope: ViewScope, from: string, to: string): C.SpaceKnownFilter | null => {
  const { layout, type } = scope.shape;
  const startId = type === "calendar" ? layout.datePropertyId : layout.startPropertyId;
  const endId = type === "timeline" ? layout.endPropertyId : undefined;
  if (typeof startId !== "string") return null;
  const shown = shownProperties(scope);
  const end = typeof endId === "string" && shown.has(endId) ? endId : startId;
  const stored = (id: string) => scope.snapshot.byId.get(id)?.type === "date";
  return {
    and: [
      {
        property: C.SpacePropertyId.make(startId),
        operator: "on_or_before",
        value: to,
        ...(stored(startId) ? { part: "start" as const } : {}),
      },
      {
        property: C.SpacePropertyId.make(end),
        operator: "on_or_after",
        value: from,
        ...(stored(end) ? { part: "end" as const } : {}),
      },
    ],
  };
};

export const query = Effect.fn("SharedDatabases.query")(function* (input: {
  readonly rootPageId: C.SpacePageId;
  readonly pageId: C.SpacePageId;
  readonly blockId: string;
  readonly viewId: string;
  readonly params: QueryParams;
  readonly environmentId: EnvironmentId;
  readonly nowMs: number;
}) {
  const { params } = input;
  const scope = yield* resolveView(input.rootPageId, input.pageId, input.blockId, input.viewId);
  const { type, group } = scope.shape;
  if (type === "form") return yield* notFound("view", input.viewId);
  const dated = type === "calendar" || type === "timeline";
  const grouped = group !== null && !dated && type !== "feed";
  const bad = { _tag: "Bad" } as const;
  const ids = [...scope.exposed.columns.map((c) => c.propertyId), ...scope.exposed.extras];
  const timeZone = yield* resolveZone(input.nowMs, params.timeZone);
  const base = requestBase(scope, input.environmentId, timeZone, ids);
  const cursor =
    params.cursor === undefined ? undefined : Option.getOrUndefined(decodeCursor(params.cursor));
  if (params.cursor !== undefined && cursor === undefined)
    return yield* new C.SpaceValidationError({ reason: "invalid_cursor" });

  let request: C.SpaceDatabaseQueryInput;
  if (dated) {
    if (params.group !== undefined || params.from === undefined || params.to === undefined)
      return bad;
    const first = dayNumber(params.from);
    const last = dayNumber(params.to);
    if (first === null || last === null || first > last) return bad;
    if (last - first + 1 > SPACE_SHARED_DATABASE_RANGE_DAYS) return bad;
    const filter = overlap(scope, params.from, params.to);
    const startId = scope.shape.layout[type === "calendar" ? "datePropertyId" : "startPropertyId"];
    if (filter === null || typeof startId !== "string") return bad;
    request = {
      ...base,
      mode: "rows",
      group: null,
      sorts: [{ property: C.SpacePropertyId.make(startId), direction: "ascending" }],
      extraFilter: filter,
      limit: SPACE_SHARED_DATABASE_WINDOW_ROWS,
      ...(cursor === undefined ? {} : { cursor }),
    };
  } else if (type === "chart") {
    if (params.from !== undefined || params.to !== undefined) return bad;
    if (params.group !== undefined || params.cursor !== undefined) return bad;
    const y = scope.shape.layout.y;
    const aggregate =
      isObject(y) && typeof y.property === "string" && typeof y.function === "string"
        ? [{ property: C.SpacePropertyId.make(y.property), function: y.function }]
        : [];
    request = {
      ...base,
      mode: "groups",
      rowsPerGroup: 0,
      properties: [],
      include: { aggregates: true },
      aggregates: aggregate,
    };
  } else {
    if (params.from !== undefined || params.to !== undefined) return bad;
    if (!grouped) {
      if (params.group !== undefined) return bad;
      request = {
        ...base,
        mode: "rows",
        ...(type === "feed" ? { group: null } : {}),
        limit: SPACE_SHARED_DATABASE_WINDOW_ROWS,
        ...(cursor === undefined ? {} : { cursor }),
      };
    } else if (params.group === undefined) {
      if (params.cursor !== undefined) return bad;
      request = { ...base, mode: "groups", rowsPerGroup: SPACE_SHARED_DATABASE_GROUP_ROWS };
    } else {
      const key = groupKeyOf(params.group);
      if (Option.isNone(key)) return bad;
      // Only a key the view's own grouping produces may scope a read; the engine matches leniently.
      const prepared = yield* Query.prepare({
        request: { ...base, mode: "rows" },
        environmentId: input.environmentId,
        nowMs: input.nowMs,
      });
      const exact =
        prepared.e.group === undefined
          ? undefined
          : exactKey(prepared.e.group, key.value, prepared.dates.weekStartsOn);
      if (exact === undefined) return bad;
      const hidden = group.hidden.map((entry) => canonical(entry));
      if (hidden.includes(canonical(exact))) return yield* notFound("view", input.viewId);
      request = {
        ...base,
        mode: "rows",
        scope: { group: exact },
        limit: SPACE_SHARED_DATABASE_WINDOW_ROWS,
        ...(cursor === undefined ? {} : { cursor }),
      };
    }
  }
  const result = yield* Query.run({
    request,
    environmentId: input.environmentId,
    nowMs: input.nowMs,
  });
  return { _tag: "Window", window: sanitizeWindow(scope, result) } as const;
});

export interface RowParams {
  readonly rootPageId: C.SpacePageId;
  readonly pageId: C.SpacePageId;
  readonly blockId: string;
  readonly viewId: string;
  readonly rowId: C.SpacePageId;
  readonly environmentId: EnvironmentId;
  readonly nowMs: number;
  readonly timeZone?: string;
}

/** The scope and the plan that answers "does this view's own filter return the row". */
const gate = Effect.fn("SharedDatabases.gate")(function* (input: RowParams) {
  const scope = yield* resolveView(input.rootPageId, input.pageId, input.blockId, input.viewId);
  if (scope.shape.type === "form") return yield* notFound("page", input.rowId);
  const ids = [...scope.exposed.columns.map((c) => c.propertyId), ...scope.exposed.extras];
  const timeZone = yield* resolveZone(input.nowMs, input.timeZone);
  const prepared = yield* Query.prepare({
    request: { ...requestBase(scope, input.environmentId, timeZone, ids), mode: "rows" },
    environmentId: input.environmentId,
    nowMs: input.nowMs,
  });
  if (!(yield* Rows.contains(prepared.plan, input.rowId)))
    return yield* notFound("page", input.rowId);
  return { scope, plan: prepared.plan, ids };
});

export const readRow = Effect.fn("SharedDatabases.readRow")(function* (
  input: RowParams & { readonly cursor?: string },
) {
  const sql = yield* SpacesSql.SpacesSql;
  const { scope, plan } = yield* gate(input);
  const [page] =
    yield* sql<RowStore.HydratePage>`SELECT page_id, title, icon, revision, created_at, updated_at, row_seq
    FROM spaces_pages WHERE page_id = ${input.rowId}`;
  if (page === undefined) return yield* notFound("page", input.rowId);
  const hydrated = yield* RowStore.hydrate(plan.c.full, [page], plan.e.properties, {
    nowMs: plan.c.dates.nowMs,
    timeZone: plan.c.dates.timeZone,
  });
  const relatedPages = sanitizeRelated(scope, hydrated.related);
  const ledger = optionLedger(scope);
  const row: SpaceSharedDatabaseRow = sanitizeRow(
    scope,
    hydrated.rows[0]!,
    new Set(Object.keys(relatedPages)),
    ledger,
  );
  const { page: loaded, window } = yield* PageShares.readBody(input.rowId, input.cursor);
  const host = yield* PageShares.locate(input.rootPageId, input.pageId);
  if (host === null) return yield* notFound("page", input.pageId);
  return {
    row,
    relatedPages,
    options: ledger.build(),
    window: { revision: window.revision, blocks: window.blocks },
    ...(window.nextCursor === null ? {} : { nextCursor: window.nextCursor }),
    breadcrumb: [
      ...host,
      {
        id: loaded.page_id,
        title: loaded.title,
        ...(loaded.icon ? { icon: loaded.icon } : {}),
      },
    ],
  } satisfies SpaceSharedDatabaseRowPage;
});

/** Passes when the row is one the view's filter returns and a live block of it uses the asset. */
export const assertRowAsset = Effect.fn("SharedDatabases.assertRowAsset")(function* (
  input: RowParams & { readonly assetId: C.SpaceAssetId },
) {
  yield* gate(input);
  return yield* PageShares.referencesAsset(input.rowId, input.assetId);
});
