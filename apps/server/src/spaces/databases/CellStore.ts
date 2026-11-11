import * as Effect from "effect/Effect";

import * as SpacesSql from "../SpacesSql.ts";
import { type CellItem, type CellRow, textItem } from "./CellCodec.ts";

const same = (a: CellItem, b: CellItem) =>
  a.ref === b.ref &&
  a.text_key === b.text_key &&
  a.text_full === b.text_full &&
  a.num === b.num &&
  a.time_start === b.time_start &&
  a.time_end === b.time_end &&
  a.flags === b.flags &&
  a.value === b.value;

export const cellsOf = Effect.fn("SpacesDatabases.cellsOf")(function* (
  pageId: string,
  propertyId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  return yield* sql<CellRow>`SELECT * FROM spaces_db_cells WHERE page_id = ${pageId} AND property_id = ${propertyId} ORDER BY ord`;
});

/**
 * Replaces exactly the cell rows of `(page, property)`. Returns whether anything changed; an
 * identical write touches nothing.
 */
export const replace = Effect.fn("SpacesDatabases.replaceCell")(function* (
  pageId: string,
  dataSourceId: string,
  propertyId: string,
  items: readonly CellItem[],
) {
  const sql = yield* SpacesSql.SpacesSql;
  const current = yield* cellsOf(pageId, propertyId);
  if (current.length === items.length && current.every((row, i) => same(row, items[i]!)))
    return false;
  if (current.length > 0)
    yield* sql`DELETE FROM spaces_db_cells WHERE page_id = ${pageId} AND property_id = ${propertyId}`;
  for (const [ord, item] of items.entries())
    yield* sql`INSERT INTO spaces_db_cells (page_id, property_id, ord, data_source_id, ref, text_key, text_full, num, time_start, time_end, flags, value)
      VALUES (${pageId}, ${propertyId}, ${ord}, ${dataSourceId}, ${item.ref}, ${item.text_key}, ${item.text_full},
      ${item.num}, ${item.time_start}, ${item.time_end}, ${item.flags}, ${item.value})`;
  return true;
});

/** Cells of several pages, grouped by page and property; ids are bound in bounded chunks. */
export const readCells = Effect.fn("SpacesDatabases.readCells")(function* (
  pageIds: readonly string[],
  propertyIds?: readonly string[],
) {
  const sql = yield* SpacesSql.SpacesSql;
  const grouped = new Map<string, Map<string, CellRow[]>>();
  for (let start = 0; start < pageIds.length; start += 200) {
    const chunk = pageIds.slice(start, start + 200);
    const rows =
      propertyIds === undefined
        ? yield* sql<CellRow>`SELECT * FROM spaces_db_cells WHERE page_id IN ${sql.in(chunk)} ORDER BY page_id, property_id, ord`
        : yield* sql<CellRow>`SELECT * FROM spaces_db_cells WHERE page_id IN ${sql.in(chunk)}
            AND property_id IN ${sql.in(propertyIds)} ORDER BY page_id, property_id, ord`;
    for (const row of rows) {
      const page = grouped.get(row.page_id) ?? new Map<string, CellRow[]>();
      grouped.set(row.page_id, page);
      page.set(row.property_id, [...(page.get(row.property_id) ?? []), row]);
    }
  }
  return grouped;
});

/** The title mirror cell: the filter, sort and aggregate copy of `spaces_pages.title`. */
export const writeTitleMirror = Effect.fn("SpacesDatabases.writeTitleMirror")(function* (
  pageId: string,
  dataSourceId: string,
  title: string,
) {
  yield* replace(pageId, dataSourceId, "title", title === "" ? [] : [textItem(title)]);
});
