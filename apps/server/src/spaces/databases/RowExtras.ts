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

/** The first top-level image block of each page in one window. */
const covers = Effect.fn("SpacesDatabases.covers")(function* (pageIds: readonly string[]) {
  const sql = yield* SpacesSql.SpacesSql;
  const first = new Map<string, string>();
  for (let start = 0; start < pageIds.length; start += CHUNK) {
    const found = yield* sql<{
      readonly page_id: string;
      readonly asset_id: string | null;
    }>`SELECT page_id, json_extract(payload, '$.content.assetId') AS asset_id FROM spaces_blocks
      WHERE page_id IN ${sql.in(pageIds.slice(start, start + CHUNK))} AND deleted = 0
      AND parent_id IS NULL AND json_extract(payload, '$.type') = 'image'
      ORDER BY page_id, rank, block_id`;
    for (const row of found)
      if (row.asset_id !== null && !first.has(row.page_id)) first.set(row.page_id, row.asset_id);
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
