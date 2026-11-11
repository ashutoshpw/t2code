import type * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import * as SpacesSql from "../../SpacesSql.ts";
import { instantIso } from "./Dates.ts";
import { type Levels, filteredRows } from "./Cte.ts";
import { liveTarget } from "./Cells.ts";
import type { Plan } from "./Plan.ts";
import type { Fragment, KeyValue } from "./Types.ts";

type Raw = Record<string, unknown>;

const norm = (value: unknown): KeyValue =>
  typeof value === "bigint"
    ? Number(value)
    : typeof value === "number" || typeof value === "string"
      ? value
      : null;
const num = (value: unknown) => (value === null || value === undefined ? undefined : Number(value));

/** Identifies one bucket across the statements of a level. */
export const bucketId = (g: KeyValue, sg: KeyValue) => JSON.stringify([g, sg]);
const idOf = (row: Raw) => bucketId(norm(row.g), norm(row.sg));
interface Stats {
  total: number;
  rwv: number;
  items: number;
  uniq: number;
  sum: number | undefined;
  min: number | undefined;
  max: number | undefined;
  nn: number;
  lo: number | undefined;
  hi: number | undefined;
  earliest?: { readonly ms: number; readonly timed: boolean };
  latest?: { readonly ms: number; readonly timed: boolean };
  createdLo?: string;
  createdHi?: string;
  median?: number;
}

const emptyStats = (total: number): Stats => ({
  total,
  rwv: 0,
  items: 0,
  uniq: 0,
  sum: undefined,
  min: undefined,
  max: undefined,
  nn: 0,
  lo: undefined,
  hi: undefined,
});

const identity = (plan: Plan, type: C.SpacePropertyType): Fragment => {
  const { sql } = plan.c;
  switch (type) {
    case "number":
      return sql`c.num`;
    case "date":
      return sql`c.time_start`;
    case "select":
    case "multi_select":
    case "status":
    case "relation":
      return sql`c.ref`;
    case "files":
      return sql`c.value`;
    default:
      return sql`COALESCE(c.text_full, c.text_key)`;
  }
};

const columnsOf = (plan: Plan, levels: Levels, prefix = "f.") => {
  const { sql } = plan.c;
  if (levels === 0) return { select: sql``, group: sql``, partition: sql`1` };
  const names = levels === 1 ? ["g"] : ["g", "sg"];
  const list = names.map((name) => `${prefix}${name}`).join(", ");
  return {
    select: sql.literal(names.map((name) => `${prefix}${name} AS ${name}`).join(", ") + ", "),
    group: sql` GROUP BY ${sql.literal(list)}`,
    partition: sql.literal(list),
  };
};

const liveCells = (plan: Plan, type: C.SpacePropertyType) => {
  const { sql } = plan.c;
  return type === "relation" ? sql` AND ${liveTarget(sql, sql`c.ref`)}` : sql``;
};

const needs = (functions: ReadonlySet<string>, ...names: string[]) =>
  names.some((name) => functions.has(name));

const loadStats = Effect.fn("SpacesDatabases.aggregateStats")(function* (
  plan: Plan,
  levels: Levels,
  property: { readonly id: string; readonly type: C.SpacePropertyType },
  functions: ReadonlySet<string>,
  totalOf: ReadonlyMap<string, number>,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const cols = columnsOf(plan, levels);
  const cte = filteredRows(plan, levels, false);
  const stats = new Map<string, Stats>();
  const at = (id: string) => {
    const found = stats.get(id) ?? emptyStats(totalOf.get(id) ?? 0);
    stats.set(id, found);
    return found;
  };
  for (const [id, total] of totalOf) stats.set(id, emptyStats(total));
  if (property.type === "unique_id") return stats;
  if (property.type === "created_time" || property.type === "last_edited_time") {
    if (!needs(functions, "earliest", "latest", "date_range")) return stats;
    const column = property.type === "created_time" ? sql`p.created_at` : sql`p.updated_at`;
    const rows = yield* sql<Raw>`${cte}
      SELECT ${cols.select}MIN(${column}) AS lo, MAX(${column}) AS hi
      FROM f JOIN spaces_pages p ON p.page_id = f.page_id${cols.group}`;
    for (const row of rows) {
      const found = at(idOf(row));
      found.createdLo = String(row.lo);
      found.createdHi = String(row.hi);
    }
    return stats;
  }
  const from = sql`FROM f JOIN spaces_db_cells c ON c.page_id = f.page_id
    AND c.property_id = ${property.id}${liveCells(plan, property.type)}`;
  const rows = yield* sql<Raw>`${cte}
    SELECT ${cols.select}COUNT(DISTINCT f.page_id) AS rwv, COUNT(*) AS items,
      COUNT(DISTINCT ${identity(plan, property.type)}) AS uniq, SUM(c.num) AS s, MIN(c.num) AS mn,
      MAX(c.num) AS mx, COUNT(c.num) AS nn, MIN(c.time_start) AS lo,
      MAX(COALESCE(c.time_end, c.time_start)) AS hi
    ${from}${cols.group}`;
  for (const row of rows) {
    const found = at(idOf(row));
    found.rwv = Number(row.rwv);
    found.items = Number(row.items);
    found.uniq = Number(row.uniq);
    found.sum = num(row.s);
    found.min = num(row.mn);
    found.max = num(row.mx);
    found.nn = Number(row.nn);
    found.lo = num(row.lo);
    found.hi = num(row.hi);
  }
  if (needs(functions, "earliest", "latest") && property.type === "date") {
    const ranked = yield* sql<Raw>`${cte}, ranked AS (
      SELECT ${cols.select}c.time_start AS lo, COALESCE(c.time_end, c.time_start) AS hi, c.flags AS fl,
        row_number() OVER (PARTITION BY ${cols.partition} ORDER BY c.time_start, c.ord) AS rl,
        row_number() OVER (PARTITION BY ${cols.partition}
          ORDER BY COALESCE(c.time_end, c.time_start) DESC, c.ord) AS rh
      ${from})
      SELECT * FROM ranked WHERE rl = 1 OR rh = 1`;
    for (const row of ranked) {
      const found = at(idOf(row));
      const timed = (Number(row.fl) & 1) === 1;
      if (Number(row.rl) === 1) found.earliest = { ms: Number(row.lo), timed };
      if (Number(row.rh) === 1) found.latest = { ms: Number(row.hi), timed };
    }
  }
  if (functions.has("median")) {
    // One statement per level: rank each bucket's values and keep the middle one or two.
    const middles = yield* sql<Raw>`${cte}, v AS (
      SELECT ${cols.select}c.num AS v,
        row_number() OVER (PARTITION BY ${cols.partition} ORDER BY c.num) AS rn,
        count(*) OVER (PARTITION BY ${cols.partition}) AS cnt
      ${from} AND c.num IS NOT NULL)
      SELECT ${sql.literal(levels === 0 ? "" : levels === 1 ? "g, " : "g, sg, ")}AVG(v) AS med
      FROM v WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)${levels === 0 ? sql`` : sql` GROUP BY ${sql.literal(levels === 1 ? "g" : "g, sg")}`}`;
    for (const row of middles) {
      const found = stats.get(idOf(row));
      if (found !== undefined && row.med !== null) found.median = Number(row.med);
    }
  }
  return stats;
});

const fraction = (part: number, whole: number) => (whole > 0 ? part / whole : undefined);

const dateText = (point: { readonly ms: number; readonly timed: boolean }) => ({
  start: point.timed ? instantIso(point.ms) : instantIso(point.ms).slice(0, 10),
  hasTime: point.timed,
});

/** The value of one aggregate function from the collected statistics (section 4.6). */
const evaluate = (
  type: C.SpacePropertyType,
  fn: C.SpaceKnownAggregate["function"],
  s: Stats,
): Pick<C.SpaceAggregateResult, "number" | "date"> => {
  const number = (value: number | undefined) => (value === undefined ? {} : { number: value });
  const timeless = type === "created_time" || type === "last_edited_time";
  switch (fn) {
    case "count":
      return number(s.total);
    case "count_values":
      return number(s.items);
    case "count_unique":
      return number(s.uniq);
    case "empty":
    case "unchecked":
      return number(s.total - s.rwv);
    case "not_empty":
    case "checked":
      return number(s.rwv);
    case "percent_empty":
    case "percent_unchecked":
      return number(fraction(s.total - s.rwv, s.total));
    case "percent_not_empty":
    case "percent_checked":
      return number(fraction(s.rwv, s.total));
    case "sum":
      return number(s.sum ?? 0);
    case "average":
      return number(s.sum === undefined || s.nn === 0 ? undefined : s.sum / s.nn);
    case "median":
      return number(s.median);
    case "min":
      return number(s.min);
    case "max":
      return number(s.max);
    case "range":
      return number(s.min === undefined || s.max === undefined ? undefined : s.max - s.min);
    case "earliest":
      if (timeless)
        return s.createdLo === undefined ? {} : { date: { start: s.createdLo, hasTime: true } };
      return s.earliest ? { date: dateText(s.earliest) } : {};
    case "latest":
      if (timeless)
        return s.createdHi === undefined ? {} : { date: { start: s.createdHi, hasTime: true } };
      return s.latest ? { date: dateText(s.latest) } : {};
    case "date_range":
      if (timeless)
        return s.createdLo === undefined || s.createdHi === undefined
          ? {}
          : number(Date.parse(s.createdHi) - Date.parse(s.createdLo));
      return number(s.lo === undefined || s.hi === undefined ? undefined : s.hi - s.lo);
  }
};

/**
 * The requested aggregates for every bucket of a level, keyed by `bucketId`; `fallback` buckets
 * (empty ones the caller adds) get results over zero rows.
 */
export const aggregates = Effect.fn("SpacesDatabases.aggregates")(function* (
  plan: Plan,
  levels: Levels,
  requested: readonly C.SpaceKnownAggregate[],
  totalOf: ReadonlyMap<string, number>,
) {
  const byProperty = new Map<string, Set<string>>();
  for (const aggregate of requested) {
    const set = byProperty.get(aggregate.property) ?? new Set<string>();
    set.add(aggregate.function);
    byProperty.set(aggregate.property, set);
  }
  const statsOf = new Map<string, ReadonlyMap<string, Stats>>();
  for (const [id, functions] of byProperty) {
    const property = plan.c.snapshot.byId.get(id)!;
    statsOf.set(id, yield* loadStats(plan, levels, property, functions, totalOf));
  }
  return (id: string): C.SpaceAggregateResult[] =>
    requested.map((aggregate) => {
      const property = plan.c.snapshot.byId.get(aggregate.property)!;
      const stats = statsOf.get(aggregate.property)?.get(id) ?? emptyStats(totalOf.get(id) ?? 0);
      return {
        property: aggregate.property,
        function: aggregate.function,
        ...evaluate(property.type, aggregate.function, stats),
      };
    });
});
