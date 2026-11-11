import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { fold } from "../Fold.ts";
import type { Property } from "../SchemaStore.ts";
import { dbError } from "../Types.ts";
import { cellLookup, hasCell, matchText, noCell } from "./Cells.ts";
import { type Bounds, instantIso, resolveOperand, resolveWithin } from "./Dates.ts";
import type { Compile, Fragment } from "./Types.ts";

const withinShape = Schema.decodeUnknownSync(C.SpaceWithinOperand);

const comparisons = {
  equals: "=",
  greater_than: ">",
  less_than: "<",
  greater_than_or_equal_to: ">=",
  less_than_or_equal_to: "<=",
} as const;

/** `true` and `false` in SQL: the empty `and` and `or`. */
const always = (c: Compile) => c.sql`1`;
const never = (c: Compile) => c.sql`0`;

const textCondition = (c: Compile, property: Property, operator: string, raw: unknown) => {
  const { sql } = c;
  const value = fold(String(raw ?? ""));
  const id = property.id;
  const text = matchText(sql);
  const positive = (where: Fragment) => hasCell(sql, id, where);
  switch (operator) {
    case "equals":
      return value === "" ? noCell(sql, id) : positive(sql`${text} = ${value}`);
    case "does_not_equal":
      return value === "" ? hasCell(sql, id) : sql`NOT ${positive(sql`${text} = ${value}`)}`;
    case "contains":
      return value === "" ? always(c) : positive(sql`instr(${text}, ${value}) > 0`);
    case "does_not_contain":
      return value === "" ? never(c) : sql`NOT ${positive(sql`instr(${text}, ${value}) > 0`)}`;
    case "starts_with":
      return value === "" ? always(c) : positive(sql`instr(${text}, ${value}) = 1`);
    default:
      return value === ""
        ? always(c)
        : positive(sql`substr(${text}, -length(${value})) = ${value}`);
  }
};

const numberCondition = (c: Compile, property: Property, operator: string, value: number) => {
  const { sql } = c;
  const match = (symbol: string) =>
    property.type === "unique_id"
      ? sql`p.row_seq ${sql.literal(symbol)} ${value}`
      : hasCell(sql, property.id, sql`c.num ${sql.literal(symbol)} ${value}`);
  if (operator === "does_not_equal") return sql`NOT ${match("=")}`;
  return match(comparisons[operator as keyof typeof comparisons]);
};

const optionCondition = (c: Compile, property: Property, operator: string, value: unknown) => {
  const { sql } = c;
  const id = property.id;
  switch (operator) {
    case "equals":
    case "contains":
      return hasCell(sql, id, sql`+c.ref = ${String(value)}`);
    case "does_not_equal":
    case "does_not_contain":
      return noCell(sql, id, sql`+c.ref = ${String(value)}`);
    default: {
      const inGroup = hasCell(
        sql,
        id,
        sql`+c.ref IN (SELECT option_id FROM spaces_db_options
          WHERE data_source_id = ${c.snapshot.source.data_source_id} AND property_id = ${id}
          AND status_group = ${String(value)})`,
      );
      return operator === "in_group" ? inGroup : sql`NOT ${inGroup}`;
    }
  }
};

/** A predicate on the comparison point `v` of one cell, in one encoding. */
const compare = (
  c: Compile,
  operator: string,
  v: Fragment,
  bounds: { readonly lo: number | string; readonly hi: number | string },
  instant?: number | string,
): Fragment => {
  const { sql } = c;
  const { lo, hi } = bounds;
  if (instant !== undefined) {
    switch (operator) {
      case "equals":
        return sql`${v} = ${instant}`;
      case "before":
        return sql`${v} < ${instant}`;
      case "after":
        return sql`${v} > ${instant}`;
      case "on_or_before":
        return sql`${v} <= ${instant}`;
      default:
        return sql`${v} >= ${instant}`;
    }
  }
  switch (operator) {
    case "before":
      return sql`${v} < ${lo}`;
    case "after":
      return sql`${v} >= ${hi}`;
    case "on_or_before":
      return sql`${v} < ${hi}`;
    case "on_or_after":
      return sql`${v} >= ${lo}`;
    default:
      return sql`${v} >= ${lo} AND ${v} < ${hi}`;
  }
};

const spanOf = (c: Compile, operator: string, value: unknown) => {
  if (operator === "within") {
    const bounds = resolveWithin(c.dates, withinShape(value));
    return { day: bounds, instant: undefined };
  }
  return resolveOperand(c.dates, value);
};

/** The predicate on one date cell (alias `c`), in the two encodings the column holds. */
const dateWhere = Effect.fn("SpacesDatabases.dateWhere")(function* (
  c: Compile,
  property: Property,
  operator: string,
  value: unknown,
  part: "start" | "end",
) {
  const { sql } = c;
  const operand = spanOf(c, operator, value);
  if (operand === undefined) return yield* dbError("invalid_filter", property.id);
  const day: Bounds = operand.day;
  const v = part === "end" ? sql`COALESCE(c.time_end, c.time_start)` : sql`c.time_start`;
  const dateOnly = compare(c, operator, v, { lo: day.fLo, hi: day.fHi });
  const timed = compare(c, operator, v, { lo: day.iLo, hi: day.iHi }, operand.instant);
  return sql`((c.flags & 1) = 0 AND (${dateOnly})) OR ((c.flags & 1) = 1 AND (${timed}))`;
});

/** A creation or edit time: one column of the page, not a cell. */
const pageTimeCondition = Effect.fn("SpacesDatabases.pageTimeCondition")(function* (
  c: Compile,
  property: Property,
  operator: string,
  value: unknown,
) {
  const { sql } = c;
  const operand = spanOf(c, operator, value);
  if (operand === undefined) return yield* dbError("invalid_filter", property.id);
  const day: Bounds = operand.day;
  const column = property.type === "created_time" ? sql`p.created_at` : sql`p.updated_at`;
  return sql`(${compare(
    c,
    operator,
    column,
    { lo: instantIso(day.iLo), hi: instantIso(day.iHi) },
    operand.instant === undefined ? undefined : instantIso(operand.instant),
  )})`;
});

/**
 * The cell predicate (alias `c`) of a positive comparison on a stored scalar property: a number
 * comparison, a select or status equality, a multi-select membership or a date comparison. These
 * can start a row search from the cell indexes; everything else has no such form.
 */
const positiveWhere = Effect.fn("SpacesDatabases.positiveWhere")(function* (
  c: Compile,
  property: Property,
  operator: string,
  value: unknown,
  part: "start" | "end",
) {
  const { sql } = c;
  switch (property.type) {
    case "number":
      return operator in comparisons
        ? sql`c.num ${sql.literal(comparisons[operator as keyof typeof comparisons])} ${Number(value)}`
        : undefined;
    case "select":
    case "status":
    case "multi_select":
      return operator === "equals" || operator === "contains"
        ? sql`c.ref = ${String(value)}`
        : undefined;
    case "date":
      return yield* dateWhere(c, property, operator, value, part);
    default:
      return undefined;
  }
});

/** Whether `positiveWhere` has a form for the condition, without compiling it. */
export const isDrivable = (property: Property, operator: string) => {
  switch (property.type) {
    case "number":
      return operator in comparisons;
    case "select":
    case "status":
    case "multi_select":
      return operator === "equals" || operator === "contains";
    case "date":
      return operator !== "is_empty" && operator !== "is_not_empty";
    default:
      return false;
  }
};

/** Number and date properties hold one cell, so conjuncts on one property can share a lookup. */
export const isSingleValued = (property: Property) =>
  property.type === "number" || property.type === "date";

/** The cell lookup of conjuncts on one property: its cells (alias `c`) that satisfy all of them. */
export const drivenLookup = Effect.fn("SpacesDatabases.drivenLookup")(function* (
  c: Compile,
  conditions: readonly {
    readonly property: Property;
    readonly operator: string;
    readonly value: unknown;
    readonly part: "start" | "end" | undefined;
  }[],
) {
  const { sql } = c;
  const [first] = conditions;
  const wheres: Fragment[] = [];
  for (const entry of conditions) {
    const where = yield* positiveWhere(
      c,
      entry.property,
      entry.operator,
      entry.value,
      entry.part ?? "start",
    );
    if (where !== undefined) wheres.push(where);
  }
  return cellLookup(
    sql,
    c.snapshot.source.data_source_id,
    first!.property.id,
    sql.and(wheres.map((where) => sql`(${where})`)),
  );
});

/** One filter condition as a predicate on row `p`. */
export const condition = Effect.fn("SpacesDatabases.compileCondition")(function* (
  c: Compile,
  property: Property,
  operator: string,
  value: unknown,
  part: "start" | "end" | undefined,
) {
  const { sql } = c;
  if (operator === "is_empty" || operator === "is_not_empty") {
    const live = property.type === "relation";
    return operator === "is_empty"
      ? noCell(sql, property.id, undefined, live)
      : hasCell(sql, property.id, undefined, live);
  }
  switch (property.type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
      return textCondition(c, property, operator, value);
    case "number":
    case "unique_id":
      return numberCondition(c, property, operator, Number(value));
    case "checkbox": {
      const checked = (operator === "equals") === (value === true);
      return checked ? hasCell(sql, property.id) : noCell(sql, property.id);
    }
    case "select":
    case "status":
    case "multi_select":
      return optionCondition(c, property, operator, value);
    case "relation":
      return operator === "contains"
        ? hasCell(sql, property.id, sql`+c.ref = ${String(value)}`, true)
        : noCell(sql, property.id, sql`+c.ref = ${String(value)}`, true);
    case "date":
      return hasCell(
        sql,
        property.id,
        yield* dateWhere(c, property, operator, value, part ?? "start"),
      );
    case "created_time":
    case "last_edited_time":
      return yield* pageTimeCondition(c, property, operator, value);
    default:
      return yield* dbError("property_not_queryable", property.id);
  }
});
