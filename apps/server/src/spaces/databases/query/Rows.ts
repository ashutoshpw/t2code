import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { byteLength, databaseLimits, ensureDatabaseLimit } from "../../CorePolicy.ts";
import * as RowExtras from "../RowExtras.ts";
import * as RowStore from "../RowStore.ts";
import * as SpacesSql from "../../SpacesSql.ts";
import * as Cursor from "./Cursor.ts";
import type { Plan } from "./Plan.ts";
import { orderBy } from "./Sort.ts";
import type { KeyValue } from "./Types.ts";

export interface Hit {
  readonly pageId: string;
  readonly at: Cursor.Position;
}

type HitRow = Record<string, unknown>;

const keyValue = (value: unknown): KeyValue =>
  typeof value === "bigint"
    ? Number(value)
    : typeof value === "number" || typeof value === "string"
      ? value
      : null;

export const hitOf = (plan: Plan, row: HitRow): Hit => ({
  pageId: String(row.page_id),
  at: {
    keys: plan.keys.map((_, i) => keyValue(row[`k${i}`])),
    position: Number(row.row_position),
    seq: Number(row.row_seq),
  },
});

/** Up to `limit + 1` rows after `after`, in the query's order; the extra row only signals "more". */
const fetchWindow = Effect.fn("SpacesDatabases.window")(function* (
  plan: Plan,
  limit: number,
  after: Cursor.Position | undefined,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const { c } = plan;
  const selected = plan.keys.map((key, i) => sql`${key.expr} AS ${sql.literal(`k${i}`)}`);
  const tail = after
    ? sql` AND ${Cursor.after(c, plan.keys, after, {
        position: sql`p.row_position`,
        seq: sql`p.row_seq`,
      })}`
    : sql``;
  const rows = yield* sql<HitRow>`SELECT ${sql.csv([
    sql`p.page_id AS page_id`,
    sql`p.row_position AS row_position`,
    sql`p.row_seq AS row_seq`,
    ...selected,
  ])}
    FROM spaces_pages p WHERE ${plan.where}${tail}
    ORDER BY ${orderBy(c, plan.keys)} LIMIT ${limit + 1}`;
  return rows.map((row) => hitOf(plan, row));
});

export const total = Effect.fn("SpacesDatabases.total")(function* (plan: Plan) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<{
    readonly n: number;
  }>`SELECT COUNT(*) AS n FROM spaces_pages p WHERE ${plan.where}`;
  return Number(row?.n ?? 0);
});

/** Whether the plan's rows include the page, for a window that is not paged to it. */
export const contains = Effect.fn("SpacesDatabases.rowsContain")(function* (
  plan: Plan,
  pageId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const found =
    yield* sql`SELECT 1 FROM spaces_pages p WHERE ${plan.where} AND p.page_id = ${pageId} LIMIT 1`;
  return found.length > 0;
});

/** Hydrates hits in order: page fields, cells and the related pages of relation cells. */
export const hydrate = Effect.fn("SpacesDatabases.hydrateHits")(function* (
  plan: Plan,
  hits: readonly Hit[],
  options?: { readonly cover?: boolean; readonly preview?: number },
) {
  const sql = yield* SpacesSql.SpacesSql;
  const pages = new Map<string, RowStore.HydratePage>();
  const ids = hits.map((hit) => hit.pageId);
  for (let start = 0; start < ids.length; start += 200) {
    const found =
      yield* sql<RowStore.HydratePage>`SELECT page_id, title, icon, revision, created_at, updated_at, row_seq
      FROM spaces_pages WHERE page_id IN ${sql.in(ids.slice(start, start + 200))}`;
    for (const page of found) pages.set(page.page_id, page);
  }
  const ordered = ids.flatMap((id) => {
    const page = pages.get(id);
    return page ? [page] : [];
  });
  const hydrated = yield* RowStore.hydrate(plan.c.full, ordered, plan.e.properties, {
    nowMs: plan.c.dates.nowMs,
    timeZone: plan.c.dates.timeZone,
  });
  const rows = yield* RowExtras.attach(plan.c.full, hydrated.rows, {
    children: plan.e.scope.parentRowId !== undefined,
    cover: options?.cover === true,
    preview: options?.preview ?? 0,
  });
  return { rows, related: hydrated.related };
});

interface RowsResult {
  readonly rows: readonly C.SpaceDatabaseRow[];
  readonly related: Record<string, C.SpaceRelatedPage>;
  readonly nextCursor: C.SpaceCursor | null;
}

/** One window of rows, cut to the response cap; the cursor follows the last row returned. */
export const page = Effect.fn("SpacesDatabases.rowsPage")(function* (
  plan: Plan,
  limit: number,
  after: Cursor.Position | undefined,
  overhead: number,
  options?: { readonly cover?: boolean; readonly preview?: number },
) {
  yield* ensureDatabaseLimit("maxQueryRows", limit);
  const fetched = yield* fetchWindow(plan, limit, after);
  const more = fetched.length > limit;
  let hits = fetched.slice(0, limit);
  const { rows, related } = yield* hydrate(plan, hits, options);
  let kept = rows.length;
  const fits = (count: number) =>
    byteLength({ rows: rows.slice(0, count), related }) + overhead <=
    databaseLimits.maxQueryResponseBytes;
  while (kept > 1 && !fits(kept)) kept--;
  if (!fits(kept) && kept > 0)
    yield* ensureDatabaseLimit("maxQueryResponseBytes", byteLength({ rows, related }) + overhead);
  hits = hits.slice(0, kept);
  const last = hits[hits.length - 1];
  const nextCursor =
    last && (more || kept < fetched.length)
      ? yield* Cursor.encode(plan.environmentId, plan.print, last.at)
      : null;
  return { rows: rows.slice(0, kept), related, nextCursor } satisfies RowsResult;
});
