import * as C from "@t2code/contracts/spaces";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { storedBlockFromRow, type BlockRow } from "./BlockStore.ts";
import { canonical, historyLimits, limits } from "./CorePolicy.ts";
import * as PageStore from "./PageStore.ts";
import type { Plan } from "./PageStructure.ts";
import * as ReferenceStore from "./ReferenceStore.ts";
import * as RevisionStore from "./RevisionStore.ts";
import * as SpacesSql from "./SpacesSql.ts";
import * as Reconciliation from "./assets/Reconciliation.ts";

export const prepare = Effect.fn("SpacesRecovery.preparePurge")(function* (plan: Plan) {
  const sql = yield* SpacesSql.SpacesSql;
  const source = plan.source;
  if (plan.recovery !== "permanentlyDelete" || !source || plan.recoveryPages.size === 0)
    return yield* new C.SpaceValidationError({ reason: "invalid_recovery_state" });
  const pageIds = [...plan.recoveryPages];
  const bodies = new Map<string, BlockRow>();
  const revisionKeys: { readonly pageId: string; readonly revision: number }[] = [];
  const budget = RevisionStore.createCaptureBudget();
  const cleanup = (rows: number) => {
    budget.rows += rows;
    if (budget.rows > limits.cleanupBatchRows)
      throw new C.SpaceLimitExceededError({
        limit: "cleanupBatchRows",
        maximum: limits.cleanupBatchRows,
        actual: budget.rows,
      });
  };
  const reconciliationIssue = Effect.fn("SpacesRecovery.reconciliationIssue")(function* (
    kind: string,
    entity: string,
  ) {
    const rows = yield* sql<{
      readonly reason: string;
    }>`SELECT reason FROM spaces_asset_reconciliation_issues WHERE kind=${kind} AND entity=${entity}`;
    for (const row of rows) {
      cleanup(1);
      plan.touch(`asset-issue:${kind}:${entity}`, { kind, entity, reason: row.reason });
    }
  });
  let retainedBytes = 0;
  for (const id of pageIds) {
    cleanup(1);
    const blocks = yield* sql<{
      readonly block_id: string;
    }>`SELECT block_id FROM spaces_blocks WHERE page_id=${id} ORDER BY block_id LIMIT ${limits.maxMutationNodes + 1}`;
    for (const key of blocks) {
      const row =
        plan.blocks.get(key.block_id) ??
        (yield* sql<BlockRow>`SELECT * FROM spaces_blocks WHERE block_id=${key.block_id}`)[0];
      if (!row) return yield* new C.SpacesUnavailableError({ stage: "storage" });
      plan.touch(`block:${row.block_id}`, { ...row });
      plan.blocks.set(row.block_id, row);
      bodies.set(row.block_id, row);
      yield* reconciliationIssue("block", row.block_id);
      cleanup(1);
      const pins = yield* sql<{
        readonly asset_id: string;
      }>`SELECT asset_id FROM spaces_block_asset_refs WHERE block_id=${row.block_id} LIMIT ${limits.cleanupBatchRows + 1}`;
      for (const pin of pins) {
        plan.touch(`block-pin:${row.block_id}`, { blockId: row.block_id, assetId: pin.asset_id });
        cleanup(1);
      }
    }
    const revisions = yield* sql<{
      readonly to_revision: number;
      readonly logical_bytes: number;
      readonly asset_count: number;
    }>`SELECT to_revision,logical_bytes,asset_count FROM spaces_revisions WHERE page_id=${id} ORDER BY to_revision LIMIT ${limits.cleanupBatchRows + 1}`;
    let pageBytes = 0;
    for (const revision of revisions) {
      revisionKeys.push({ pageId: id, revision: revision.to_revision });
      yield* reconciliationIssue("history", canonical([id, revision.to_revision]));
      plan.touch(`revision:${id}:${revision.to_revision}`, { pageId: id, ...revision });
      cleanup(1);
      const pins = yield* sql<{
        readonly asset_id: string;
      }>`SELECT asset_id FROM spaces_revision_asset_refs WHERE page_id=${id} AND to_revision=${revision.to_revision} ORDER BY asset_id LIMIT ${limits.cleanupBatchRows + 1}`;
      if (pins.length !== revision.asset_count)
        return yield* new C.SpacesUnavailableError({ stage: "storage" });
      for (const pin of pins) {
        plan.touch(`revision-pin:${id}:${revision.to_revision}:${pin.asset_id}`, {
          pageId: id,
          toRevision: revision.to_revision,
          assetId: pin.asset_id,
        });
        cleanup(1);
      }
      pageBytes += revision.logical_bytes;
    }
    const [counter] = yield* sql<{
      readonly retained_revision_count: number;
      readonly retained_revision_bytes: number;
    }>`SELECT retained_revision_count,retained_revision_bytes FROM spaces_pages WHERE page_id=${id}`;
    if (
      counter?.retained_revision_count !== revisions.length ||
      counter.retained_revision_bytes !== pageBytes
    )
      return yield* new C.SpacesUnavailableError({ stage: "storage" });
    retainedBytes += pageBytes;
    if (retainedBytes > historyLimits.cleanupBatchBytes)
      return yield* new C.SpacesUnavailableError({ stage: "capacity" });
    if (plan.pages.get(id)!.owner_block_id !== null) cleanup(1);
  }
  budget.bytes = retainedBytes;
  const marker =
    source.owner_block_id === null ? undefined : plan.blocks.get(source.owner_block_id);
  const externalMarker =
    marker && !plan.recoveryPages.has(C.SpacePageId.make(marker.page_id)) ? marker : undefined;
  const parent = externalMarker
    ? plan.pages.get(C.SpacePageId.make(externalMarker.page_id))
    : undefined;
  if (
    externalMarker &&
    (!parent ||
      (!externalMarker.deleted && storedBlockFromRow(externalMarker).type !== "child_page"))
  )
    return yield* new C.SpacesUnavailableError({ stage: "storage" });
  if (externalMarker) {
    yield* reconciliationIssue("block", externalMarker.block_id);
    cleanup(1);
    plan.produced({ retireBlockId: externalMarker.block_id });
    const pins = yield* sql<{
      readonly asset_id: string;
    }>`SELECT asset_id FROM spaces_block_asset_refs WHERE block_id=${externalMarker.block_id} LIMIT ${limits.cleanupBatchRows + 1}`;
    for (const pin of pins) {
      plan.touch(`block-pin:${externalMarker.block_id}`, {
        blockId: externalMarker.block_id,
        assetId: pin.asset_id,
      });
      cleanup(1);
    }
  }
  const [meta] = yield* sql<{
    readonly revision_bytes: number;
  }>`SELECT revision_bytes FROM spaces_core WHERE singleton=1`;
  if (!meta || meta.revision_bytes < retainedBytes)
    return yield* new C.SpacesUnavailableError({ stage: "storage" });
  return { source, pageIds, bodies, revisionKeys, budget, retainedBytes, externalMarker, parent };
});

export const purge = Effect.fn("SpacesRecovery.purge")(function* (
  plan: Plan,
  mutationId: string,
  now: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const { source, pageIds, bodies, revisionKeys, budget, retainedBytes, externalMarker, parent } =
    yield* prepare(plan);
  for (const key of revisionKeys)
    yield* Reconciliation.issue("history", canonical([key.pageId, key.revision]), null);
  for (const id of bodies.keys()) yield* Reconciliation.issue("block", id, null);
  for (const id of pageIds) {
    yield* sql`DELETE FROM spaces_page_owners WHERE child_page_id=${id}`;
  }
  for (const id of pageIds) {
    yield* sql`DELETE FROM spaces_revisions WHERE page_id=${id}`;
    yield* sql`DELETE FROM spaces_block_asset_refs WHERE block_id IN (SELECT block_id FROM spaces_blocks WHERE page_id=${id})`;
    yield* sql`DELETE FROM spaces_blocks WHERE page_id=${id}`;
    yield* sql`UPDATE spaces_ids SET deleted=1 WHERE id=${id} AND kind='page'`;
  }
  for (const row of bodies.values())
    yield* sql`UPDATE spaces_ids SET deleted=1,merged_into=COALESCE(${row.merged_into},merged_into) WHERE id=${row.block_id} AND kind='block'`;
  for (const id of pageIds) yield* sql`DELETE FROM spaces_pages WHERE page_id=${id}`;
  yield* sql`UPDATE spaces_core SET revision_bytes=revision_bytes-${retainedBytes} WHERE singleton=1`;
  const timestamp = DateTime.formatIso(DateTime.makeUnsafe(now));
  const changedPages: C.SpacePageRevisionGuard[] = [];
  const changedRoots: C.SpaceRootRevisionGuard[] = [];
  if (externalMarker && parent) {
    const count = parent.block_count - 1;
    const bytes = parent.block_bytes - externalMarker.logical_bytes;
    if (count < 0 || bytes < 0) return yield* new C.SpacesUnavailableError({ stage: "storage" });
    plan.produced({
      pageId: parent.page_id,
      revision: parent.revision + 1,
      blockCount: count,
      blockBytes: bytes,
    });
    yield* sql`UPDATE spaces_pages SET revision=revision+1,block_count=${count},block_bytes=${bytes},updated_at=${timestamp} WHERE page_id=${parent.page_id}`;
    yield* RevisionStore.capture(
      {
        pageId: parent.page_id,
        toRevision: parent.revision + 1,
        mutationId,
        pageBefore: PageStore.preimage(parent),
        ownerBefore: PageStore.ownerPreimage(parent),
        trashBefore: PageStore.trashSnapshot(parent),
        blocksBefore: [{ id: externalMarker.block_id, row: { ...externalMarker } }],
      },
      now,
      budget,
    );
    const mergedInto = externalMarker.deleted ? externalMarker.merged_into : null;
    const payload = canonical({ id: externalMarker.block_id, pageId: parent.page_id, mergedInto });
    yield* sql`UPDATE spaces_blocks SET deleted=1,merged_into=${mergedInto},payload=${payload},logical_bytes=${Buffer.byteLength(payload, "utf8")} WHERE block_id=${externalMarker.block_id}`;
    yield* ReferenceStore.release([externalMarker.block_id]);
    changedPages.push({ pageId: parent.page_id, revision: parent.revision + 1 });
  }
  if (source.root_order !== null) {
    yield* sql`UPDATE spaces SET root_order_revision=root_order_revision+1,updated_at=${timestamp} WHERE space_id=${source.space_id}`;
    changedRoots.push({
      spaceId: source.space_id,
      rootOrderRevision: plan.roots.get(source.space_id)!.rootOrderRevision + 1,
    });
  }
  yield* sql`UPDATE spaces_core SET catalog_revision=catalog_revision+1 WHERE singleton=1`;
  return {
    pageId: source.page_id,
    deletedPageIds: pageIds,
    changed: { pages: changedPages, roots: changedRoots },
  };
});
