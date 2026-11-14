import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as SpacesSql from "../SpacesSql.ts";
import { truncateBytes } from "./Fold.ts";
import { isObject, parseJson } from "./Json.ts";
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

const TEXT_BLOCKS = new Set(["paragraph", "quote", "bulleted_item", "numbered_item", "toggle"]);

const decodeRun = Schema.decodeUnknownOption(C.SpaceRichRun);
const decodeRuns = (value: unknown): C.SpaceRichRun[] =>
  Array.isArray(value)
    ? value.flatMap((run) => {
        const decoded = decodeRun(run);
        return Option.isSome(decoded) ? [decoded.value] : [];
      })
    : [];

const previewBlock = (payload: string): C.SpaceRowPreviewBlock => {
  try {
    const block = parseJson(payload);
    if (!isObject(block) || typeof block.type !== "string" || !isObject(block.content))
      return { type: "unknown", runs: [] };
    const { type, content } = block;
    if (type === "code")
      return {
        type,
        runs: typeof content.text === "string" ? [{ text: content.text, marks: [] }] : [],
      };
    const runs =
      TEXT_BLOCKS.has(type) || type === "heading" || type === "todo_item" || type === "callout"
        ? decodeRuns(content.runs)
        : [];
    return {
      type,
      runs,
      ...(type === "heading" && (content.level === 1 || content.level === 2 || content.level === 3)
        ? { level: content.level }
        : {}),
      ...(type === "todo_item" && typeof content.checked === "boolean"
        ? { checked: content.checked }
        : {}),
    };
  } catch {
    return { type: "unknown", runs: [] };
  }
};

/** The first `count` blocks of a row's body, cut to the per-row byte cap. */
const capPreview = (blocks: readonly C.SpaceRowPreviewBlock[], count: number, more: boolean) => {
  let left = C.SPACE_FEED_PREVIEW_ROW_BYTES;
  let cut = false;
  const kept: C.SpaceRowPreviewBlock[] = [];
  for (const block of blocks.slice(0, count)) {
    if (cut) break;
    const runs: C.SpaceRichRun[] = [];
    for (const run of block.runs) {
      const size = Buffer.byteLength(run.text, "utf8");
      if (size <= left) {
        runs.push(run);
        left -= size;
        continue;
      }
      const text = truncateBytes(run.text, left);
      if (text.length > 0) runs.push({ ...run, text });
      cut = true;
      break;
    }
    kept.push({ ...block, runs });
  }
  return { blocks: kept, more: more || cut };
};

/** The first top-level body blocks of each page, one windowed statement per chunk. */
const previews = Effect.fn("SpacesDatabases.previews")(function* (
  pageIds: readonly string[],
  count: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const byPage = new Map<string, string[]>();
  for (let start = 0; start < pageIds.length; start += CHUNK) {
    const found = yield* sql<{
      readonly page_id: string;
      readonly payload: string;
    }>`SELECT page_id, payload FROM (
        SELECT b.page_id AS page_id, b.payload AS payload,
          row_number() OVER (PARTITION BY b.page_id ORDER BY b.rank, b.block_id) AS n
        FROM spaces_blocks b
        WHERE b.page_id IN ${sql.in(pageIds.slice(start, start + CHUNK))} AND b.deleted = 0
        AND b.parent_id IS NULL)
      WHERE n <= ${count + 1} ORDER BY page_id, n`;
    for (const row of found) {
      const list = byPage.get(row.page_id) ?? [];
      list.push(row.payload);
      byPage.set(row.page_id, list);
    }
  }
  return new Map(
    pageIds.map((id) => {
      const payloads = byPage.get(id) ?? [];
      return [id, capPreview(payloads.map(previewBlock), count, payloads.length > count)] as const;
    }),
  );
});

/** Adds `childCount` (when scoped to a parent) and `cover` (when asked) to one window of rows. */
export const attach = Effect.fn("SpacesDatabases.attachRowExtras")(function* (
  snapshot: Snapshot,
  rows: readonly C.SpaceDatabaseRow[],
  want: { readonly children: boolean; readonly cover: boolean; readonly preview: number },
) {
  const parentProperty = snapshot.source.sub_items_property_id;
  const ids = rows.map((row) => row.page.id);
  const counts =
    want.children && parentProperty !== null && ids.length > 0
      ? yield* childCounts(snapshot.source.data_source_id, parentProperty, ids)
      : undefined;
  const found = want.cover && ids.length > 0 ? yield* covers(ids) : undefined;
  const body = want.preview > 0 && ids.length > 0 ? yield* previews(ids, want.preview) : undefined;
  if (counts === undefined && found === undefined && body === undefined) return rows;
  return rows.map((row): C.SpaceDatabaseRow => {
    const assetId = found?.get(row.page.id);
    const previewOf = body?.get(row.page.id);
    return {
      ...row,
      ...(counts === undefined ? {} : { childCount: counts.get(row.page.id) ?? 0 }),
      ...(assetId === undefined ? {} : { cover: { assetId: C.SpaceAssetId.make(assetId) } }),
      ...(previewOf === undefined ? {} : { preview: previewOf }),
    };
  });
});
