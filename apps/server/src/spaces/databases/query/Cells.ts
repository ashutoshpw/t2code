import type { Fragment, Sql } from "./Types.ts";

/** A relation target counts only while its row is not in the trash. */
export const liveTarget = (sql: Sql, ref: Fragment) =>
  sql`EXISTS (SELECT 1 FROM spaces_pages t WHERE t.page_id = ${ref} AND t.trash_batch_id IS NULL)`;

/**
 * True when row `p` has a cell of `propertyId` that satisfies `where` (alias `c`). Predicates on
 * `c.ref` are written `+c.ref` so the planner keeps the primary-key lookup instead of scanning
 * every cell that shares one option.
 */
export const hasCell = (sql: Sql, propertyId: string, where?: Fragment, live = false): Fragment =>
  sql`EXISTS (SELECT 1 FROM spaces_db_cells c WHERE c.page_id = p.page_id
    AND c.property_id = ${propertyId}${where ? sql` AND (${where})` : sql``}${live ? sql` AND ${liveTarget(sql, sql`c.ref`)}` : sql``})`;

export const noCell = (sql: Sql, propertyId: string, where?: Fragment, live = false): Fragment =>
  sql`NOT ${hasCell(sql, propertyId, where, live)}`;

/** The matchable text of a text cell: the full folded text, or the key when it was not cut. */
export const matchText = (sql: Sql) => sql`COALESCE(c.text_full, c.text_key)`;

/** The cells of `propertyId` that satisfy `where` (alias `c`), as a one-column subquery. */
export const cellLookup = (
  sql: Sql,
  dataSourceId: string,
  propertyId: string,
  where: Fragment,
): Fragment =>
  sql`SELECT c.page_id FROM spaces_db_cells c
    WHERE c.data_source_id = ${dataSourceId} AND c.property_id = ${propertyId} AND (${where})`;
