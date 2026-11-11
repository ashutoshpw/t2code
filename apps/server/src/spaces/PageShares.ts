import type { SpacePageShare, SpaceSharedPage } from "@t2code/contracts";
import { SpacePageShareId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as BlockStore from "./BlockStore.ts";
import { limits } from "./CorePolicy.ts";
import * as Liveness from "./databases/Liveness.ts";
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

const findById = Effect.fn("SpacesPageShares.findById")(function* (shareId: SpacePageShareId) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<ShareRow>`SELECT * FROM spaces_page_shares WHERE share_id = ${shareId}`;
  return row ? shareFromRow(row) : null;
});

/** One share per page: the new row ends the old link. */
export const replace = Effect.fn("SpacesPageShares.replace")(function* (share: SpacePageShare) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* PageStore.assertActive(yield* PageStore.read(share.pageId));
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
  const breadcrumb: Array<{
    readonly id: C.SpacePageId;
    readonly title: string;
    readonly icon?: string;
  }> = [];
  let current: C.SpacePageId | null = pageId;
  while (current !== null && breadcrumb.length < limits.maxDepth) {
    const row: PageStore.PageRow | null = yield* PageStore.load(current).pipe(
      Effect.catchTags({ SpaceNotFoundError: () => Effect.succeed(null) }),
    );
    if (row === null || row.trash_batch_id !== null) return null;
    breadcrumb.unshift({
      id: row.page_id,
      title: row.title,
      ...(row.icon ? { icon: row.icon } : {}),
    });
    if (row.page_id === rootPageId) return breadcrumb;
    if (row.parent_page_id === null || row.owner_deleted !== 0) return null;
    current = row.parent_page_id;
  }
  return null;
});

const RANK_LENGTH = 32;
// Bound to body_revision like authenticated cursors, so an edit between windows ends the walk.
const shareCursor = (bodyRevision: number, row: BlockStore.BlockRow) =>
  C.SpaceCursor.make(`${bodyRevision}:${row.rank}${row.block_id}`);

const parseShareCursor = (cursor: string, bodyRevision: number) => {
  const split = cursor.indexOf(":");
  const rest = cursor.slice(split + 1);
  if (split < 1 || cursor.slice(0, split) !== String(bodyRevision) || rest.length <= RANK_LENGTH)
    return null;
  return { rank: rest.slice(0, RANK_LENGTH), id: rest.slice(RANK_LENGTH) };
};

/** The share, the page asked for and its place in the tree, so one read answers a viewer's request. */
export const resolve = Effect.fn("SpacesPageShares.resolve")(function* (
  shareId: SpacePageShareId,
  requested: C.SpacePageId | undefined,
) {
  const share = yield* findById(shareId);
  if (share === null) return null;
  const pageId = requested ?? share.pageId;
  // A row or a page under a row dies with its database; the link ends instead of serving a ghost.
  if (yield* Liveness.insideDeadDatabase(share.pageId))
    return { share, pageId, breadcrumb: null, rootLive: false };
  const breadcrumb = yield* locate(share.pageId, pageId);
  const rootLive =
    breadcrumb !== null || pageId === share.pageId
      ? breadcrumb !== null
      : (yield* locate(share.pageId, share.pageId)) !== null;
  return { share, pageId, breadcrumb, rootLive };
});

/** One window of the page's blocks, in the byte and block bounds authenticated readers get. */
export const readBody = Effect.fn("SpacesPageShares.readBody")(function* (
  pageId: C.SpacePageId,
  cursor?: string,
) {
  const page = yield* PageStore.load(pageId);
  if (cursor !== undefined && cursor.length > limits.maxCursorBytes)
    return yield* new C.SpaceValidationError({ reason: "invalid_cursor" });
  const after = cursor === undefined ? undefined : parseShareCursor(cursor, page.body_revision);
  if (cursor !== undefined && after === null)
    return yield* new C.SpaceValidationError({ reason: "invalid_cursor" });
  const window = yield* BlockStore.readWindow({
    pageId,
    revision: page.revision,
    after: after ?? undefined,
    limit: limits.maxBlockWindowBlocks,
    continuation: (row) => Effect.succeed(shareCursor(page.body_revision, row)),
  });
  return { page, window };
});

export const read = Effect.fn("SpacesPageShares.read")(function* (
  rootPageId: C.SpacePageId,
  expiresAt: string,
  pageId: C.SpacePageId,
  breadcrumb: SpaceSharedPage["breadcrumb"],
  cursor?: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const { page, window } = yield* readBody(pageId, cursor);
  const children = yield* sql<{
    readonly page_id: C.SpacePageId;
    readonly title: string;
    readonly icon: string | null;
    readonly updated_at: string;
  }>`SELECT p.page_id, p.title, p.icon, p.updated_at FROM spaces_blocks b
    JOIN spaces_page_owners o ON o.owner_block_id = b.block_id
    JOIN spaces_pages p ON p.page_id = o.child_page_id
    WHERE b.page_id = ${pageId} AND b.deleted = 0 AND json_extract(b.payload,'$.type') = 'child_page'
      AND p.trash_batch_id IS NULL
    ORDER BY b.rank, b.block_id LIMIT ${limits.maxListRows}`;
  return {
    rootPageId,
    expiresAt,
    page: {
      id: page.page_id,
      title: page.title,
      ...(page.icon ? { icon: page.icon } : {}),
      updatedAt: page.updated_at,
    },
    window: { revision: window.revision, blocks: window.blocks },
    ...(window.nextCursor === null ? {} : { nextCursor: window.nextCursor }),
    breadcrumb,
    children: children.map((child) => ({
      id: child.page_id,
      title: child.title,
      ...(child.icon ? { icon: child.icon } : {}),
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

export const purgeExpired = Effect.fn("SpacesPageShares.purgeExpired")(function* (now: number) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`DELETE FROM spaces_page_shares WHERE expires_at <= ${DateTime.formatIso(DateTime.makeUnsafe(now))}`;
});
