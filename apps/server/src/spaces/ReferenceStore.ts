import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlError from "effect/sql/SqlError";

import { byteLength, checkLimit, limits } from "./CorePolicy.ts";
import * as PageStore from "./PageStore.ts";
import * as SpacesSql from "./SpacesSql.ts";
import * as Reconciliation from "./assets/Reconciliation.ts";

interface Identity {
  readonly id: string;
  readonly kind: string;
  readonly deleted: number;
  readonly merged_into: string | null;
  readonly page_id: C.SpacePageId | null;
}

// Legacy tombstones remain authoritative until a bounded maintenance pass copies their identity.
const read = Effect.fn("SpacesReferences.identity")(function* (id: string) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<Identity>`SELECT i.id,i.kind,
    CASE WHEN b.deleted=1 THEN 1 ELSE i.deleted END AS deleted,
    CASE WHEN b.deleted=1 THEN b.merged_into ELSE i.merged_into END AS merged_into,
    CASE WHEN b.deleted=0 THEN b.page_id ELSE NULL END AS page_id
    FROM spaces_ids i LEFT JOIN spaces_blocks b ON b.block_id=i.id AND i.kind='block'
    WHERE i.id=${id}`;
  return row;
});

export const resolve = Effect.fn("SpacesReferences.resolve")(function* (
  target: C.SpaceReferenceResolveInput["target"],
): Effect.fn.Return<
  C.SpaceReferenceResolveResult,
  C.SpaceServiceError | SqlError.SqlError,
  SpacesSql.SpacesSql
> {
  const requested = target.kind === "page" ? target.pageId : target.blockId;
  checkLimit("maxIdBytes", byteLength(requested));
  let current: string = requested;
  const seen = new Set<string>();
  const maxHops = limits.maxReferenceHops ?? 32;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (seen.has(current)) return { status: "unavailable" };
    seen.add(current);
    const row = yield* read(current);
    if (!row || row.kind !== target.kind) return { status: "unavailable" };
    if (row.deleted) {
      if (target.kind === "page" || row.merged_into === null) return { status: "deleted" };
      current = row.merged_into;
      continue;
    }
    if (target.kind === "page") {
      const page = yield* PageStore.load(C.SpacePageId.make(current)).pipe(
        Effect.catchTags({ SpaceNotFoundError: () => Effect.void }),
      );
      if (page?.trash_batch_id !== null && page !== undefined)
        return { status: "trashed", pageId: page.page_id };
      return page
        ? { status: "resolved", page: PageStore.summary(page) }
        : { status: "unavailable" };
    }
    if (row.page_id === null) return { status: "unavailable" };
    const ownerPage = yield* PageStore.load(row.page_id);
    if (ownerPage.trash_batch_id !== null) return { status: "trashed", pageId: ownerPage.page_id };
    const sql = yield* SpacesSql.SpacesSql;
    const [child] = yield* sql<{
      readonly page_id: C.SpacePageId;
    }>`SELECT p.page_id FROM spaces_page_owners o JOIN spaces_pages p ON p.page_id=o.child_page_id WHERE o.owner_block_id=${current} AND p.trash_batch_id IS NOT NULL`;
    if (child) return { status: "trashed", pageId: child.page_id };
    const page = PageStore.summary(ownerPage);
    const blockId = C.SpaceBlockId.make(current);
    return current === requested
      ? { status: "resolved", page, blockId }
      : { status: "merged", page, blockId, requestedBlockId: target.blockId };
  }
  return { status: "unavailable" };
});

const retire = Effect.fn("SpacesReferences.retire")(function* (id: string, target: string | null) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_ids SET deleted=1,merged_into=${target} WHERE id=${id} AND kind='block'`;
});

export const flatten = Effect.fn("SpacesReferences.flatten")(function* (
  id: string,
  target: string,
  touch: (id: string) => void,
  reserve: (value: unknown) => void,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const queue = [id];
  const seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const predecessors = yield* sql<{ readonly id: string }>`
      SELECT id FROM spaces_ids WHERE merged_into=${queue[i]!}
      UNION ALL SELECT block_id AS id FROM spaces_blocks WHERE deleted=1 AND merged_into=${queue[i]!}
      LIMIT ${limits.maxMutationNodes + 1}`;
    if (predecessors.length > limits.maxMutationNodes)
      return yield* new C.SpacesUnavailableError({ stage: "capacity" });
    for (const predecessor of predecessors) {
      if (predecessor.id === target)
        return yield* new C.SpaceValidationError({ reason: "invalid_merge" });
      if (seen.has(predecessor.id)) continue;
      seen.add(predecessor.id);
      touch(predecessor.id);
      reserve({ id: predecessor.id, mergedInto: target });
      queue.push(predecessor.id);
    }
  }
  for (const predecessor of queue.slice(1)) {
    yield* retire(predecessor, target);
    yield* sql`UPDATE spaces_blocks SET merged_into=${target} WHERE block_id=${predecessor} AND deleted=1`;
  }
});

// Caller has captured reverse deltas and pins before releasing the old body rows.
export const release = Effect.fn("SpacesReferences.release")(function* (ids: readonly string[]) {
  const sql = yield* SpacesSql.SpacesSql;
  for (const id of ids) {
    const [row] = yield* sql<{
      readonly merged_into: string | null;
    }>`SELECT merged_into FROM spaces_blocks WHERE block_id=${id} AND deleted=1`;
    if (!row) continue;
    yield* retire(id, row.merged_into);
    yield* sql`DELETE FROM spaces_block_asset_refs WHERE block_id=${id}`;
    yield* sql`DELETE FROM spaces_blocks WHERE block_id=${id} AND deleted=1`;
    yield* Reconciliation.issue("block", id, null);
  }
});

export const maintain = Effect.fn("SpacesReferences.maintain")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  let bytes = 0;
  let retiredRows = 0;
  const retired = yield* sql<{
    readonly block_id: string;
    readonly page_id: string;
    readonly logical_bytes: number;
  }>`SELECT block_id,page_id,logical_bytes FROM spaces_blocks WHERE deleted=1 ORDER BY block_id LIMIT ${Math.floor(limits.cleanupBatchRows / 2)}`;
  for (const row of retired) {
    const next = bytes + row.logical_bytes + byteLength({ ...row });
    if (next > limits.maxMutationBytes) break;
    bytes = next;
    const pins = yield* sql`SELECT 1 FROM spaces_block_asset_refs WHERE block_id=${row.block_id}
        UNION ALL SELECT 1 FROM spaces_page_owners WHERE owner_block_id=${row.block_id} LIMIT 1`;
    if (pins.length) continue;
    const issues =
      yield* sql`SELECT 1 FROM spaces_asset_reconciliation_issues WHERE kind='block' AND entity=${row.block_id}`;
    if (retiredRows + 2 + issues.length > limits.cleanupBatchRows) break;
    retiredRows += 2 + issues.length;
    yield* release([row.block_id]);
    yield* sql`UPDATE spaces_pages SET block_count=block_count-1,block_bytes=block_bytes-${row.logical_bytes} WHERE page_id=${row.page_id}`;
  }
  const [meta] = yield* sql<{
    readonly reference_cursor: string | null;
  }>`SELECT reference_cursor FROM spaces_core WHERE singleton=1`;
  const after =
    meta?.reference_cursor === null || meta?.reference_cursor === undefined
      ? sql``
      : sql`AND id>${meta.reference_cursor}`;
  const redirects = yield* sql<{
    readonly id: string;
    readonly merged_into: string;
  }>`SELECT id,merged_into FROM spaces_ids WHERE deleted=1 AND merged_into IS NOT NULL ${after} ORDER BY id LIMIT ${Math.floor(limits.cleanupBatchRows / 4)}`;
  let cursor: string | null = null;
  for (const row of redirects) {
    const next = yield* read(row.merged_into);
    const cost = byteLength({ ...row }) + (next ? byteLength({ ...next }) : 0);
    if (bytes + cost > limits.maxMutationBytes) break;
    bytes += cost;
    if (
      next?.kind === "block" &&
      next.deleted &&
      next.merged_into !== null &&
      next.merged_into !== row.id &&
      next.merged_into !== row.merged_into
    )
      yield* sql`UPDATE spaces_ids SET merged_into=${next.merged_into} WHERE id=${row.id}`;
    cursor = row.id;
  }
  if (redirects.length === 0 || cursor !== null)
    yield* sql`UPDATE spaces_core SET reference_cursor=${cursor} WHERE singleton=1`;
});
