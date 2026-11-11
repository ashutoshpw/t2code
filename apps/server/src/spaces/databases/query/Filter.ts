import type * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { fold } from "../Fold.ts";
import { notFound } from "../Types.ts";
import { hasCell } from "./Cells.ts";
import { condition } from "./Operators.ts";
import type { Compile, Fragment } from "./Types.ts";

/** A validated filter tree as one predicate on row `p`: `and []` is true, `or []` is false. */
export const compileFilter = (
  c: Compile,
  node: C.SpaceKnownFilter,
): Effect.Effect<Fragment, C.SpaceServiceError> => {
  const { sql } = c;
  if ("and" in node)
    return Effect.forEach(node.and, (child) => compileFilter(c, child)).pipe(
      Effect.map((parts) => (parts.length === 0 ? sql`1` : sql`(${sql.and(parts)})`)),
    );
  if ("or" in node)
    return Effect.forEach(node.or, (child) => compileFilter(c, child)).pipe(
      Effect.map((parts) => (parts.length === 0 ? sql`0` : sql`(${sql.or(parts)})`)),
    );
  const property = c.snapshot.byId.get(node.property);
  if (property === undefined || property.deletedAtMs !== null)
    return Effect.fail(notFound("property", node.property));
  return condition(c, property, node.operator, node.value, node.part);
};

/** The base row set: the data source's rows, never trashed rows or templates. */
export const baseRows = (c: Compile) =>
  c.sql`p.data_source_id = ${c.snapshot.source.data_source_id} AND p.trash_batch_id IS NULL AND p.row_template = 0`;

/** `search`: the title contains the folded text. */
export const searchCondition = (c: Compile, search: string) =>
  hasCell(c.sql, "title", c.sql`instr(COALESCE(c.text_full, c.text_key), ${fold(search)}) > 0`);
