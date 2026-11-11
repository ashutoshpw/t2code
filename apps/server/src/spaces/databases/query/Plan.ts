import * as Effect from "effect/Effect";

import { fingerprint } from "./Cursor.ts";
import { baseRows, compileFilter, searchCondition } from "./Filter.ts";
import { member } from "./Group.ts";
import { hasCell, noCell } from "./Cells.ts";
import { type SortExpr, sortExprs } from "./Sort.ts";
import type { Compile, Effective, Fragment } from "./Types.ts";

/** A validated, compiled query: everything the row, group and aggregate statements share. */
export interface Plan {
  readonly c: Compile;
  readonly e: Effective;
  readonly environmentId: string;
  readonly dataSourceId: string;
  readonly dataRevision: number;
  readonly keys: readonly SortExpr[];
  /** The row predicate without any cursor. */
  readonly where: Fragment;
  readonly print: string;
}

const scopeParts = Effect.fn("SpacesDatabases.compileScope")(function* (c: Compile, e: Effective) {
  const { sql } = c;
  const parts: Fragment[] = [];
  const { scope } = e;
  if (scope.parentRowId !== undefined) {
    const parent = c.snapshot.source.sub_items_property_id!;
    parts.push(
      scope.parentRowId === null
        ? noCell(sql, parent, undefined, true)
        : hasCell(sql, parent, sql`+c.ref = ${scope.parentRowId}`, true),
    );
  }
  if (scope.group !== undefined && e.group !== undefined)
    parts.push(yield* member(c, e.group, scope.group));
  if (scope.subGroup !== undefined && e.subGroup !== undefined)
    parts.push(yield* member(c, e.subGroup, scope.subGroup));
  return parts;
});

const rowPredicate = Effect.fn("SpacesDatabases.rowPredicate")(function* (
  c: Compile,
  e: Effective,
) {
  const parts: Fragment[] = [baseRows(c)];
  for (const filter of e.filters) parts.push(yield* compileFilter(c, filter));
  if (e.search !== "") parts.push(searchCondition(c, e.search));
  parts.push(...(yield* scopeParts(c, e)));
  return c.sql.and(parts);
});

export const makePlan = Effect.fn("SpacesDatabases.plan")(function* (input: {
  readonly c: Compile;
  readonly e: Effective;
  readonly environmentId: string;
  readonly dataRevision: number;
}) {
  const { c, e } = input;
  const dataSourceId = c.snapshot.source.data_source_id;
  return {
    c,
    e,
    environmentId: input.environmentId,
    dataSourceId,
    dataRevision: input.dataRevision,
    keys: sortExprs(c, e.sorts),
    where: yield* rowPredicate(c, e),
    print: fingerprint({ dataSourceId, effective: e, c }),
  } satisfies Plan;
});
