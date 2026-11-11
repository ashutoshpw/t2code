import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import * as AssetReferences from "../assets/References.ts";
import * as Reconciliation from "../assets/Reconciliation.ts";
import * as BlockStore from "../BlockStore.ts";
import * as Hooks from "../databases/Hooks.ts";
import * as PageStore from "../PageStore.ts";
import * as ReferenceStore from "../ReferenceStore.ts";
import * as RevisionStore from "../RevisionStore.ts";
import * as SpacesSql from "../SpacesSql.ts";
import { isoNow } from "../databases/Types.ts";

/**
 * Applies block mutations to a page and records the revision. `applyBlockBatch` and the server's
 * own edits of database blocks both run through here so they cannot drift apart.
 */
export const applyBatch = Effect.fn("SpacesService.applyBatch")(function* (input: {
  readonly page: PageStore.PageRow;
  readonly mutations: readonly C.SpaceBlockMutation[];
  readonly mutationId: string;
  readonly nowMs: number;
  readonly requestBytes: number;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  const { page } = input;
  const result = yield* BlockStore.apply(
    page.page_id,
    input.mutations,
    page.block_count,
    page.block_bytes,
    input.requestBytes,
  );
  if (!result.changed) return { changed: false, revision: page.revision };
  const now = isoNow(input.nowMs);
  yield* sql`UPDATE spaces_pages SET revision = revision + 1, body_revision = revision + 1, block_count = ${result.count}, block_bytes = ${result.bytes}, updated_at = ${now} WHERE page_id = ${page.page_id}`;
  yield* RevisionStore.capture(
    {
      pageId: page.page_id,
      toRevision: page.revision + 1,
      mutationId: input.mutationId,
      pageBefore: PageStore.preimage(page),
      blocksBefore: result.blocksBefore,
    },
    input.nowMs,
  );
  yield* AssetReferences.publish(result.assetRefsAfter);
  for (const changedBlock of result.blocksAfter)
    yield* Reconciliation.noteBlock(changedBlock.id, changedBlock.payload);
  yield* ReferenceStore.release(result.retiredIds);
  yield* Hooks.afterBlocksApplied(page, result.blocksAfter, input.nowMs);
  // The catalog revision guards list cursors; only changes to media references move asset lists.
  if (result.assetRefsAfter.length > 0)
    yield* sql`UPDATE spaces_core SET catalog_revision = catalog_revision + 1 WHERE singleton = 1`;
  return { changed: true, revision: page.revision + 1 };
});
