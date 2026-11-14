// @effect-diagnostics nodeBuiltinImport:off -- stable IDs are allocated by the platform cryptographic generator.
import * as NodeCrypto from "node:crypto";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import * as BlockKinds from "./BlockKinds.ts";
import * as BlockStore from "./BlockStore.ts";
import { byteLength, ensureLimit, limits } from "./CorePolicy.ts";
import * as Liveness from "./databases/Liveness.ts";
import * as PageStore from "./PageStore.ts";
import * as SpacesSql from "./SpacesSql.ts";
import { applyBatch } from "./service/BlockBatch.ts";

/** Room in a subtree response for the page summary, refs and envelope next to the blocks. */
const ENVELOPE_BYTES = 16_384;
const RANK_END = 1n << 128n;

export type Source =
  | {
      readonly status: "found";
      readonly row: BlockStore.BlockRow;
      readonly page: PageStore.PageRow;
    }
  | { readonly status: "deleted" }
  | { readonly status: "unavailable" };

/** The live synced_block behind a block id, on a page that is reachable (not trashed or in a dead database). */
export const resolveSource = Effect.fn("SpacesSynced.resolveSource")(function* (blockId: string) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] =
    yield* sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks WHERE block_id = ${blockId}`;
  if (!row || row.deleted) return { status: "deleted" } satisfies Source;
  if (!BlockKinds.strictSyncedBlock(BlockStore.storedBlockFromRow(row)))
    return { status: "unavailable" } satisfies Source;
  const page = yield* PageStore.load(C.SpacePageId.make(row.page_id));
  if (!(yield* Liveness.pageLive(page.page_id))) return { status: "unavailable" } satisfies Source;
  return { status: "found", row, page } satisfies Source;
});

/**
 * The original and its descendants in tree order. Stops, with `complete: false`, at the block
 * window or at `budgetBytes` of serialized blocks.
 */
export const subtreeBlocks = Effect.fn("SpacesSynced.subtreeBlocks")(function* (
  root: BlockStore.BlockRow,
  maxBlocks: number,
  budgetBytes: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const children = (parentId: string, room: number) =>
    sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks INDEXED BY spaces_blocks_children
      WHERE page_id = ${root.page_id} AND deleted = 0 AND parent_id = ${parentId}
      ORDER BY rank, block_id LIMIT ${room + 1}`;
  const first = BlockStore.storedBlockFromRow(root);
  const blocks: C.SpaceBlock[] = [first];
  const seen = new Set([root.block_id]);
  let bytes = byteLength(first);
  let complete = true;
  const stack = [{ rows: yield* children(root.block_id, maxBlocks), index: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const row = top.rows[top.index++];
    if (row === undefined) {
      stack.pop();
      continue;
    }
    if (seen.has(row.block_id)) return yield* new C.SpaceValidationError({ reason: "cycle" });
    seen.add(row.block_id);
    const block = yield* BlockStore.blockFromRow(row);
    const size = byteLength(block) + 1;
    if (blocks.length >= maxBlocks || bytes + size > budgetBytes) {
      complete = false;
      break;
    }
    yield* ensureLimit("maxDepth", stack.length + 1);
    blocks.push(block);
    bytes += size;
    if (BlockStore.isContainer(block))
      stack.push({ rows: yield* children(row.block_id, maxBlocks - blocks.length), index: 0 });
  }
  return { blocks, complete };
});

/** Live copies of an original on pages outside the trash, by page title. */
const copies = Effect.fn("SpacesSynced.copies")(function* (sourceBlockId: string, listed: number) {
  const sql = yield* SpacesSql.SpacesSql;
  const refs = yield* sql<{
    readonly block_id: string;
    readonly page_id: string;
    readonly space_id: string;
    readonly title: string;
    readonly icon: string | null;
  }>`SELECT b.block_id, b.page_id, p.space_id, p.title, p.icon FROM spaces_blocks b
    JOIN spaces_pages p ON p.page_id = b.page_id
    WHERE b.deleted = 0 AND json_extract(b.payload, '$.type') = 'synced_ref'
      AND json_extract(b.payload, '$.content.sourceBlockId') = ${sourceBlockId}
      AND p.trash_batch_id IS NULL
    ORDER BY p.title, b.block_id LIMIT ${listed}`;
  const [count] = yield* sql<{
    readonly total: number;
  }>`SELECT count(*) AS total FROM spaces_blocks b
    JOIN spaces_pages p ON p.page_id = b.page_id
    WHERE b.deleted = 0 AND json_extract(b.payload, '$.type') = 'synced_ref'
      AND json_extract(b.payload, '$.content.sourceBlockId') = ${sourceBlockId}
      AND p.trash_batch_id IS NULL`;
  return { refs, total: count?.total ?? 0 };
});

export const readSubtree = Effect.fn("SpacesSynced.readSubtree")(function* (blockId: string) {
  const source = yield* resolveSource(blockId);
  if (source.status !== "found") return source;
  const body = yield* subtreeBlocks(
    source.row,
    limits.maxBlockWindowBlocks,
    limits.maxBlockWindowResponseBytes - ENVELOPE_BYTES,
  );
  const found = yield* copies(blockId, C.SPACE_SYNCED_REFS_LISTED);
  return {
    status: "found" as const,
    page: source.page,
    revision: source.page.revision,
    ...body,
    refs: found.refs.map((ref): C.SpaceSyncedRefSummary => ({
      blockId: C.SpaceBlockId.make(ref.block_id),
      pageId: C.SpacePageId.make(ref.page_id),
      spaceId: C.SpaceId.make(ref.space_id),
      title: ref.title,
      ...(ref.icon ? { icon: ref.icon } : {}),
    })),
    refCount: found.total,
  };
});

const rankNumber = Effect.fnUntraced(function* (rank: string) {
  if (!/^[0-9a-f]{32}$/.test(rank))
    return yield* new C.SpaceValidationError({ reason: "invalid_order" });
  return BigInt(`0x${rank}`);
});
const rankHex = (value: bigint) => value.toString(16).padStart(32, "0");

/**
 * Turns copies into ordinary blocks: each copy is deleted and replaced by fresh copies of the
 * original's descendants. At most 64 copies per call; the rest stay synced.
 */
export const unsync = Effect.fn("SpacesSynced.unsync")(function* (
  input: C.SpaceUnsyncInput,
  mutationId: string,
  nowMs: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const source = yield* resolveSource(input.sourceBlockId);
  if (source.status === "deleted")
    return yield* new C.SpaceNotFoundError({ entity: "block", id: input.sourceBlockId });
  if (source.status === "unavailable")
    return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
  // The delete, the copies and the touched parent must fit one batch.
  const body = yield* subtreeBlocks(
    source.row,
    limits.maxMutationNodes - 1,
    Number.MAX_SAFE_INTEGER,
  );
  if (!body.complete) yield* ensureLimit("maxMutationNodes", limits.maxMutationNodes + 1);
  const descendants = body.blocks.slice(1);
  const ids = input.refBlockIds;
  const rows = yield* ids === undefined
    ? sql<BlockStore.BlockRow>`SELECT b.* FROM spaces_blocks b JOIN spaces_pages p ON p.page_id = b.page_id
        WHERE b.deleted = 0 AND json_extract(b.payload, '$.type') = 'synced_ref'
          AND json_extract(b.payload, '$.content.sourceBlockId') = ${input.sourceBlockId}
          AND p.trash_batch_id IS NULL
        ORDER BY b.page_id, b.rank, b.block_id LIMIT ${C.SPACE_UNSYNC_MAX_REFS}`
    : sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks WHERE block_id IN ${sql.in(ids)} AND deleted = 0
        ORDER BY page_id, rank, block_id`;
  for (const id of ids ?? [])
    if (!rows.some((row) => row.block_id === id))
      return yield* new C.SpaceNotFoundError({ entity: "block", id });
  const top = descendants.filter((block) => block.parentId === source.row.block_id);
  const revisions = new Map<string, number>();
  for (const ref of rows) {
    const stored = BlockKinds.strictSyncedRefBlock(BlockStore.storedBlockFromRow(ref));
    if (stored?.content.sourceBlockId !== input.sourceBlockId)
      return yield* new C.SpaceNotFoundError({ entity: "block", id: ref.block_id });
    const page = yield* PageStore.read(C.SpacePageId.make(ref.page_id));
    if (!(yield* Liveness.pageLive(page.page_id))) continue;
    const [next] = yield* sql<{ readonly rank: string }>`SELECT rank FROM spaces_blocks
      WHERE page_id = ${ref.page_id} AND deleted = 0 AND parent_id IS ${ref.parent_id}
        AND (rank, block_id) > (${ref.rank}, ${ref.block_id}) ORDER BY rank, block_id LIMIT 1`;
    const low = yield* rankNumber(ref.rank);
    const step = ((next ? yield* rankNumber(next.rank) : RANK_END) - low) / BigInt(top.length + 1);
    if (top.length > 0 && step < 1n)
      return yield* new C.SpaceValidationError({ reason: "invalid_order" });
    const fresh = new Map(
      descendants.map((block) => [block.id, C.SpaceBlockId.make(NodeCrypto.randomUUID())]),
    );
    const parentId = ref.parent_id === null ? null : C.SpaceBlockId.make(ref.parent_id);
    const mutations: C.SpaceBlockMutation[] = [
      { kind: "delete", blockId: C.SpaceBlockId.make(ref.block_id) },
      ...descendants.map((block): C.SpaceBlockMutation => {
        const index = top.indexOf(block);
        return {
          kind: "insert",
          block: {
            ...block,
            id: fresh.get(block.id)!,
            parentId: index >= 0 ? parentId : (fresh.get(block.parentId!) ?? null),
            order: index >= 0 ? rankHex(low + step * BigInt(index + 1)) : block.order,
          },
        };
      }),
    ];
    const result = yield* applyBatch({
      page,
      mutations,
      mutationId,
      nowMs,
      requestBytes: byteLength(mutations),
    });
    revisions.set(ref.page_id, result.revision);
  }
  return [...revisions].map(([pageId, revision]) => ({
    pageId: C.SpacePageId.make(pageId),
    revision,
  }));
});
