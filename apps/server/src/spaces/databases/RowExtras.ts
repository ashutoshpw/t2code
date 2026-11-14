import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import * as SpacesSql from "../SpacesSql.ts";
import type { Snapshot } from "./SchemaStore.ts";

const CHUNK = 200;

/** Live children per parent row of one window, through the sub-items parent property. */
const childCounts = Effect.fn("SpacesDatabases.childCounts")(function* (
  dataSourceId: string,
  parentProperty: string,
  pageIds: readonly string[],
) {
  const sql = yield* SpacesSql.SpacesSql;
  const counts = new Map<string, number>();
  for (let start = 0; start < pageIds.length; start += CHUNK) {
    const found = yield* sql<{
      readonly parent: string;
      readonly n: number;
    }>`SELECT c.ref AS parent, COUNT(*) AS n FROM spaces_db_cells c
      JOIN spaces_pages p ON p.page_id = c.page_id AND p.trash_batch_id IS NULL AND p.row_template = 0
      WHERE c.ref IN ${sql.in(pageIds.slice(start, start + CHUNK))}
      AND c.data_source_id = ${dataSourceId} AND c.property_id = ${parentProperty}
      GROUP BY c.ref`;
    for (const row of found) counts.set(row.parent, Number(row.n));
  }
  return counts;
});

/**
 * The first top-level image block of each page in one window. Only blocks with a row in the
 * asset reference table are read for their payload, so a page of a thousand text blocks costs
 * a thousand key lookups, not a thousand JSON parses; the first image per page is cut in SQL.
 */
const covers = Effect.fn("SpacesDatabases.covers")(function* (pageIds: readonly string[]) {
  const sql = yield* SpacesSql.SpacesSql;
  const first = new Map<string, string>();
  for (let start = 0; start < pageIds.length; start += CHUNK) {
    const found = yield* sql<{
      readonly page_id: string;
      readonly asset_id: string;
    }>`WITH assets AS MATERIALIZED (
        SELECT b.page_id AS page_id, r.asset_id AS asset_id, b.rank AS rank, b.block_id AS block_id,
          b.payload AS payload
        FROM spaces_blocks b CROSS JOIN spaces_block_asset_refs r ON r.block_id = b.block_id
        WHERE b.page_id IN ${sql.in(pageIds.slice(start, start + CHUNK))} AND b.deleted = 0
        AND b.parent_id IS NULL)
      SELECT page_id, asset_id FROM (
        SELECT page_id, asset_id, row_number() OVER (PARTITION BY page_id ORDER BY rank, block_id) AS n
        FROM assets WHERE json_extract(payload, '$.type') = 'image')
      WHERE n = 1`;
    for (const row of found) first.set(row.page_id, row.asset_id);
  }
  return first;
});

/** Adds `childCount` (when scoped to a parent) and `cover` (when asked) to one window of rows. */
export const attach = Effect.fn("SpacesDatabases.attachRowExtras")(function* (
  snapshot: Snapshot,
  rows: readonly C.SpaceDatabaseRow[],
  want: { readonly children: boolean; readonly cover: boolean },
) {
  const parentProperty = snapshot.source.sub_items_property_id;
  const ids = rows.map((row) => row.page.id);
  const counts =
    want.children && parentProperty !== null && ids.length > 0
      ? yield* childCounts(snapshot.source.data_source_id, parentProperty, ids)
      : undefined;
  const found = want.cover && ids.length > 0 ? yield* covers(ids) : undefined;
  if (counts === undefined && found === undefined) return rows;
  return rows.map((row): C.SpaceDatabaseRow => {
    const assetId = found?.get(row.page.id);
    return {
      ...row,
      ...(counts === undefined ? {} : { childCount: counts.get(row.page.id) ?? 0 }),
      ...(assetId === undefined ? {} : { cover: { assetId: C.SpaceAssetId.make(assetId) } }),
    };
  });
});
