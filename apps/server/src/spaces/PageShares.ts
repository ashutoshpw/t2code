import type { SpacePageShare, SpaceSharedPage } from "@t2code/contracts";
import { SpacePageShareId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import * as BlockStore from "./BlockStore.ts";
import { limits } from "./CorePolicy.ts";
import * as PageStore from "./PageStore.ts";
import * as SpacesSql from "./SpacesSql.ts";

interface ShareRow {
  readonly page_id: C.SpacePageId;
  readonly share_id: string;
  readonly host: string;
  readonly created_at: string;
  readonly expires_at: string;
}

const shareFromRow = (row: ShareRow): SpacePageShare => ({
  id: SpacePageShareId.make(row.share_id),
  pageId: row.page_id,
  host: row.host,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

export const findByPage = Effect.fn("SpacesPageShares.findByPage")(function* (
  pageId: C.SpacePageId,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<ShareRow>`SELECT * FROM spaces_page_shares WHERE page_id = ${pageId}`;
  return row ? shareFromRow(row) : null;
});

export const findById = Effect.fn("SpacesPageShares.findById")(function* (
  shareId: SpacePageShareId,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<ShareRow>`SELECT * FROM spaces_page_shares WHERE share_id = ${shareId}`;
  return row ? shareFromRow(row) : null;
});

/** One share per page: the new row ends the old link. */
export const replace = Effect.fn("SpacesPageShares.replace")(function* (share: SpacePageShare) {
  const sql = yield* SpacesSql.SpacesSql;
  PageStore.assertActive(yield* PageStore.read(share.pageId));
  yield* sql`INSERT OR REPLACE INTO spaces_page_shares (page_id, share_id, host, created_at, expires_at)
    VALUES (${share.pageId}, ${share.id}, ${share.host}, ${share.createdAt}, ${share.expiresAt})`;
});

export const remove = Effect.fn("SpacesPageShares.remove")(function* (pageId: C.SpacePageId) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`DELETE FROM spaces_page_shares WHERE page_id = ${pageId}`;
});

/**
 * The titles from the shared root down to the page, or null when the page is not a live
 * descendant of the root. Walks parents upward, so the cost is the page's depth.
 */
export const locate = Effect.fn("SpacesPageShares.locate")(function* (
  rootPageId: C.SpacePageId,
  pageId: C.SpacePageId,
) {
  const breadcrumb: Array<{ readonly id: C.SpacePageId; readonly title: string }> = [];
  let current: C.SpacePageId | null = pageId;
  while (current !== null && breadcrumb.length < limits.maxDepth) {
    const row: PageStore.PageRow | null = yield* PageStore.load(current).pipe(
      Effect.catchTags({ SpaceNotFoundError: () => Effect.succeed(null) }),
    );
    if (row === null || row.trash_batch_id !== null) return null;
    breadcrumb.unshift({ id: row.page_id, title: row.title });
    if (row.page_id === rootPageId) return breadcrumb;
    if (row.parent_page_id === null || row.owner_deleted !== 0) return null;
    current = row.parent_page_id;
  }
  return null;
});

export const read = Effect.fn("SpacesPageShares.read")(function* (
  rootPageId: C.SpacePageId,
  expiresAt: string,
  pageId: C.SpacePageId,
  breadcrumb: SpaceSharedPage["breadcrumb"],
) {
  const sql = yield* SpacesSql.SpacesSql;
  const page = yield* PageStore.load(pageId);
  const rows = yield* sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks
    WHERE page_id = ${pageId} AND deleted = 0 ORDER BY rank, block_id LIMIT ${limits.maxPageBlocks + 1}`;
  const byParent = new Map<string | null, BlockStore.BlockRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.parent_id);
    if (siblings) siblings.push(row);
    else byParent.set(row.parent_id, [row]);
  }
  const blocks: C.SpaceBlock[] = [];
  const pending = [...(byParent.get(null) ?? [])].reverse();
  while (pending.length > 0 && blocks.length < limits.maxPageBlocks) {
    const row = pending.pop()!;
    blocks.push(yield* BlockStore.blockFromRow(row));
    pending.push(...[...(byParent.get(row.block_id) ?? [])].reverse());
  }
  const children = yield* sql<{
    readonly page_id: C.SpacePageId;
    readonly title: string;
    readonly updated_at: string;
  }>`SELECT p.page_id, p.title, p.updated_at FROM spaces_blocks b
    JOIN spaces_page_owners o ON o.owner_block_id = b.block_id
    JOIN spaces_pages p ON p.page_id = o.child_page_id
    WHERE b.page_id = ${pageId} AND b.deleted = 0 AND json_extract(b.payload,'$.type') = 'child_page'
      AND p.trash_batch_id IS NULL
    ORDER BY b.rank, b.block_id LIMIT ${limits.maxListRows}`;
  return {
    rootPageId,
    expiresAt,
    page: { id: page.page_id, title: page.title, updatedAt: page.updated_at },
    window: { revision: page.revision, blocks },
    breadcrumb,
    children: children.map((child) => ({
      id: child.page_id,
      title: child.title,
      updatedAt: child.updated_at,
    })),
  } satisfies SpaceSharedPage;
});

export const referencesAsset = Effect.fn("SpacesPageShares.referencesAsset")(function* (
  pageId: C.SpacePageId,
  assetId: C.SpaceAssetId,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const rows = yield* sql`SELECT 1 FROM spaces_block_asset_refs r
    JOIN spaces_blocks b ON b.block_id = r.block_id
    WHERE b.page_id = ${pageId} AND b.deleted = 0 AND r.asset_id = ${assetId} LIMIT 1`;
  return rows.length > 0;
});
