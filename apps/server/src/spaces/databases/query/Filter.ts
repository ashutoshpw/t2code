import type * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

import { fold } from "../Fold.ts";
import { notFound } from "../Types.ts";
import { hasCell } from "./Cells.ts";
import { condition, drivenLookup, isDrivable, isSingleValued } from "./Operators.ts";
import type { Compile, Fragment } from "./Types.ts";

type Leaf = Extract<C.SpaceKnownFilter, { readonly property: unknown }>;

/** The conjunct leaves whose cell lookup starts the row search; see `chooseDriven`. */
export type Driven = ReadonlySet<C.SpaceKnownFilter>;

/**
 * A lookup that finds fewer cells than this starts a row search that only needs a first window
 * (default order, no groups or aggregates): the matches are looked up by key and sorted, at most
 * this many. At or above it the ordered walk of the row index wins, since it stops after the
 * window and a sort of the whole match set does not.
 */
export const DRIVE_BELOW = 512;
/**
 * The same limit when every match is needed anyway (a sort, groups, aggregates): looking up a
 * bounded set beats testing every row of the data source.
 */
export const DRIVE_BELOW_ALL = 4096;

const propertyOf = (c: Compile, node: Leaf) => {
  const property = c.snapshot.byId.get(node.property);
  return property === undefined || property.deletedAtMs !== null ? undefined : property;
};

/** A conjunct that can start the row search from the cell indexes. */
const drivable = (c: Compile, node: C.SpaceKnownFilter): node is Leaf => {
  if (!("property" in node)) return false;
  const property = propertyOf(c, node);
  return property !== undefined && isDrivable(property, node.operator);
};

/**
 * The conjuncts of an `and` that a cell index can drive: one lookup per property for the
 * single-valued ones (a range is one cell test, not two), one per condition otherwise.
 */
const drivenParts = (c: Compile, children: readonly C.SpaceKnownFilter[], chosen?: Driven) => {
  const byProperty = new Map<string, Leaf[]>();
  const separate: Leaf[] = [];
  const rest: C.SpaceKnownFilter[] = [];
  for (const child of children) {
    if (!drivable(c, child) || (chosen !== undefined && !chosen.has(child))) {
      rest.push(child);
      continue;
    }
    if (isSingleValued(propertyOf(c, child)!)) {
      const group = byProperty.get(child.property) ?? [];
      group.push(child);
      byProperty.set(child.property, group);
    } else separate.push(child);
  }
  return { groups: [...byProperty.values(), ...separate.map((leaf) => [leaf])], rest };
};

const lookupOf = (c: Compile, leaves: readonly Leaf[]) =>
  drivenLookup(
    c,
    leaves.map((leaf) => ({
      property: propertyOf(c, leaf)!,
      operator: leaf.operator,
      value: leaf.value,
      part: leaf.part,
    })),
  );

/**
 * Decides, before the filter is compiled, which conjuncts start the row search from the cell
 * indexes: those whose lookup finds fewer than `below` cells, counted by one bounded probe
 * each. A broad conjunct stays a per-row test so the default order can stop at the first window.
 */
export const chooseDriven = Effect.fn("SpacesDatabases.chooseDriven")(function* (
  c: Compile,
  filters: readonly C.SpaceKnownFilter[],
  below: number,
) {
  const chosen = new Set<C.SpaceKnownFilter>();
  const visit: (
    nodes: readonly C.SpaceKnownFilter[],
  ) => Effect.Effect<void, C.SpaceServiceError | SqlError> = Effect.fn(
    "SpacesDatabases.chooseDriven.visit",
  )(function* (nodes) {
    const { groups } = drivenParts(c, nodes);
    for (const group of groups) {
      const lookup = yield* lookupOf(c, group);
      const [row] = yield* c.sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM (${lookup} LIMIT ${below})`;
      if (Number(row?.n ?? 0) < below) for (const leaf of group) chosen.add(leaf);
    }
    for (const node of nodes) if ("and" in node) yield* visit(node.and);
  });
  for (const node of filters) yield* visit([node]);
  return chosen satisfies Driven;
});

/**
 * A validated filter tree as one predicate on row `p`: `and []` is true, `or []` is false.
 * `conjunct` is true while every ancestor is an `and`: such a condition must hold on its own, so
 * a chosen conjunct may start the row search from the cell indexes.
 */
export const compileFilter = (
  c: Compile,
  node: C.SpaceKnownFilter,
  chosen: Driven,
  conjunct = true,
): Effect.Effect<Fragment, C.SpaceServiceError> => {
  const { sql } = c;
  if ("and" in node) {
    const { groups, rest } = conjunct
      ? drivenParts(c, node.and, chosen)
      : { groups: [], rest: node.and };
    return Effect.all([
      Effect.forEach(groups, (group) =>
        lookupOf(c, group).pipe(Effect.map((lookup) => sql`p.page_id IN (${lookup})`)),
      ),
      Effect.forEach(rest, (child) => compileFilter(c, child, chosen, conjunct)),
    ]).pipe(
      Effect.map(([lookups, parts]) =>
        lookups.length + parts.length === 0 ? sql`1` : sql`(${sql.and([...lookups, ...parts])})`,
      ),
    );
  }
  if ("or" in node)
    return Effect.forEach(node.or, (child) => compileFilter(c, child, chosen, false)).pipe(
      Effect.map((parts) => (parts.length === 0 ? sql`0` : sql`(${sql.or(parts)})`)),
    );
  const property = propertyOf(c, node);
  if (property === undefined) return Effect.fail(notFound("property", node.property));
  if (conjunct && chosen.has(node))
    return lookupOf(c, [node]).pipe(Effect.map((lookup) => sql`p.page_id IN (${lookup})`));
  return condition(c, property, node.operator, node.value, node.part);
};

/**
 * The base row set: the data source's rows, never trashed rows or templates. With a driven
 * conjunct the planner must start from the cell lookup, so the data source test is a plain
 * comparison it cannot walk the page index by.
 */
export const baseRows = (c: Compile, scanFree = false) =>
  scanFree
    ? c.sql`+p.data_source_id = ${c.snapshot.source.data_source_id} AND p.trash_batch_id IS NULL AND p.row_template = 0`
    : c.sql`p.data_source_id = ${c.snapshot.source.data_source_id} AND p.trash_batch_id IS NULL AND p.row_template = 0`;

/** `search`: the title contains the folded text. */
export const searchCondition = (c: Compile, search: string) =>
  hasCell(c.sql, "title", c.sql`instr(COALESCE(c.text_full, c.text_key), ${fold(search)}) > 0`);
