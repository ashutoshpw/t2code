import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ensureDatabaseLimit } from "../CorePolicy.ts";
import * as PageStore from "../PageStore.ts";
import { applyBatch } from "../service/BlockBatch.ts";
import * as SpacesSql from "../SpacesSql.ts";
import { parseJson } from "./Json.ts";
import * as Liveness from "./Liveness.ts";
import { dbError } from "./Types.ts";

const decodeBlock = Schema.decodeUnknownOption(C.SpaceDatabaseBlock, { onExcessProperty: "error" });

interface EditContext {
  readonly mutationId: string;
  readonly nowMs: number;
  readonly requestBytes: number;
}

/** Appends a new top-level database block, ranked after the page's last one like root pages. */
export const appendBlock = Effect.fn("SpacesDatabases.appendBlock")(function* (
  ctx: EditContext & {
    readonly pageId: C.SpacePageId;
    readonly blockId: C.SpaceBlockId;
    readonly databaseId: C.SpaceDatabaseId;
    readonly viewIds: readonly C.SpaceViewId[];
  },
) {
  const sql = yield* SpacesSql.SpacesSql;
  const page = yield* PageStore.read(ctx.pageId);
  yield* PageStore.assertActive(page);
  yield* Liveness.assertPageLive(page.page_id);
  const [last] = yield* sql<{
    readonly rank: string;
  }>`SELECT rank FROM spaces_blocks WHERE page_id = ${page.page_id} AND parent_id IS NULL AND deleted = 0 ORDER BY rank DESC, block_id DESC LIMIT 1`;
  const rank = last ? BigInt(`0x${last.rank}`) + 1n : 1n;
  if (rank >= 1n << 128n) return yield* new C.SpaceValidationError({ reason: "invalid_order" });
  const block = {
    id: ctx.blockId,
    parentId: null,
    order: rank.toString(16).padStart(32, "0"),
    type: "database" as const,
    version: 1 as const,
    content: { databaseId: ctx.databaseId, viewIds: ctx.viewIds },
  };
  const result = yield* applyBatch({
    page,
    mutations: [{ kind: "insert", block }],
    mutationId: ctx.mutationId,
    nowMs: ctx.nowMs,
    requestBytes: ctx.requestBytes,
  });
  return { pageId: page.page_id, blockId: ctx.blockId, revision: result.revision };
});

/** Rewrites the view tab list of an existing database block of `databaseId`. */
export const editViewIds = Effect.fn("SpacesDatabases.editViewIds")(function* (
  ctx: EditContext & {
    readonly target: { readonly pageId: C.SpacePageId; readonly blockId: C.SpaceBlockId };
    readonly databaseId: string;
    readonly edit: (ids: readonly C.SpaceViewId[]) => readonly C.SpaceViewId[];
  },
) {
  const sql = yield* SpacesSql.SpacesSql;
  const page = yield* PageStore.read(ctx.target.pageId);
  yield* PageStore.assertActive(page);
  yield* Liveness.assertPageLive(page.page_id);
  const [row] = yield* sql<{
    readonly payload: string;
  }>`SELECT payload FROM spaces_blocks WHERE block_id = ${ctx.target.blockId} AND page_id = ${page.page_id} AND deleted = 0`;
  if (!row) return yield* new C.SpaceNotFoundError({ entity: "block", id: ctx.target.blockId });
  const decoded = decodeBlock(parseJson(row.payload));
  if (decoded._tag !== "Some" || decoded.value.content.databaseId !== ctx.databaseId)
    return yield* dbError("invalid_view");
  const viewIds = ctx.edit(decoded.value.content.viewIds);
  yield* ensureDatabaseLimit("maxViewsPerDatabase", viewIds.length);
  const same =
    viewIds.length === decoded.value.content.viewIds.length &&
    viewIds.every((id, i) => id === decoded.value.content.viewIds[i]);
  if (same) return { pageId: page.page_id, blockId: ctx.target.blockId, revision: page.revision };
  const result = yield* applyBatch({
    page,
    mutations: [
      {
        kind: "replace",
        block: { ...decoded.value, content: { ...decoded.value.content, viewIds } },
      },
    ],
    mutationId: ctx.mutationId,
    nowMs: ctx.nowMs,
    requestBytes: ctx.requestBytes,
  });
  return { pageId: page.page_id, blockId: ctx.target.blockId, revision: result.revision };
});
