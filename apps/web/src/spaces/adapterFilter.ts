import { isHistoryTransaction } from "@tiptap/pm/history";
import type { Transaction } from "@tiptap/pm/state";
import { AddMarkStep, RemoveMarkStep } from "@tiptap/pm/transform";
import {
  isKnownSpaceBlock,
  isSameSpaceDatabaseBlock,
  isSpaceDatabaseBlock,
  isSpaceSyncedBlock,
  isSpaceSyncedRef,
  isSpaceTabPaneBlock,
  isSpaceTabsBlock,
  mediaAssetId,
} from "@t2code/client-runtime/spaces";
import type { SpaceBlock, SpaceBlockId } from "@t2code/contracts/spaces";

import {
  canEditSpaceEditorBlock,
  sameSpaceValue,
  spaceDocumentBlocks,
  spaceMentionRangeSafe,
} from "./document";
import { captionBoundary, entries, type Operation, type SpaceEditorBatch } from "./adapterModel";

export interface SpaceTransactionContext {
  readonly operation: Operation | undefined;
  readonly committed: ReadonlySet<SpaceBlockId>;
  readonly batch: SpaceEditorBatch;
  readonly mediaAllowed: (before: SpaceBlock | null, after: SpaceBlock | null) => boolean;
}

/** Whether a document-changing transaction may apply; throws are treated as a rejection by the caller. */
export function allowSpaceTransaction(tr: Transaction, ctx: SpaceTransactionContext): boolean {
  const { operation, batch } = ctx;
  const localHistory = operation?.history === true && isHistoryTransaction(tr);
  for (const [i, step] of tr.steps.entries()) {
    const doc = tr.docs[i]!;
    let safe = true;
    step.getMap().forEach((from, to) => {
      if (
        !captionBoundary(doc, from) ||
        !captionBoundary(doc, to) ||
        (!localHistory && !spaceMentionRangeSafe(doc, from, to))
      )
        safe = false;
    });
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep)
      safe &&=
        captionBoundary(doc, step.from) &&
        captionBoundary(doc, step.to) &&
        (localHistory || spaceMentionRangeSafe(doc, step.from, step.to));
    if (!safe) return false;
  }
  const before = entries(tr.before);
  const after = entries(tr.doc);
  if (
    !operation &&
    (before.length !== after.length ||
      before.some((entry, i) => {
        const next = after[i];
        return (
          !next || !sameSpaceValue(entry.block, next.block) || entry.node.type !== next.node.type
        );
      }))
  )
    return false;
  if (!operation) {
    const canonicalBefore = new Map(
      spaceDocumentBlocks(tr.before).map((block) => [block.id, block]),
    );
    if (
      batch.mutations.some(
        (mutation) =>
          mutation.kind !== "replace" ||
          !sameSpaceValue(
            { ...canonicalBefore.get(mutation.block.id), content: mutation.block.content },
            mutation.block,
          ),
      )
    )
      return false;
  }
  const oldBlocks = new Map(spaceDocumentBlocks(tr.before).map((b) => [b.id, b]));
  const newBlocks = new Map(spaceDocumentBlocks(tr.doc).map((b) => [b.id, b]));
  for (const id of new Set([...oldBlocks.keys(), ...newBlocks.keys()])) {
    const old = oldBlocks.get(id) ?? null,
      next = newBlocks.get(id) ?? null;
    if ((old && mediaAssetId(old)) || (next && mediaAssetId(next))) {
      if (
        !sameSpaceValue(old, next) &&
        ((old && before.find((e) => e.block.id === id)?.node.type.name === "spaceAtom") ||
          !ctx.mediaAllowed(old, next))
      )
        return false;
    }
  }
  for (const entry of before.filter(
    (item) => item.node.type.name === "spaceAtom" && !mediaAssetId(item.block),
  )) {
    const next = after.find((item) => item.block.id === entry.block.id);
    if (!next && entry.block.type === "divider" && canEditSpaceEditorBlock(entry.block)) continue;
    if (
      !next &&
      !ctx.committed.has(entry.block.id) &&
      isKnownSpaceBlock(entry.block) &&
      entry.block.type !== "child_page"
    )
      continue;
    if (isSpaceDatabaseBlock(entry.block)) {
      const allowed = operation?.database === true || localHistory;
      if (!next && allowed) continue;
      if (
        next &&
        entry.block.parentId === next.block.parentId &&
        isSameSpaceDatabaseBlock(entry.block, next.block) &&
        (allowed || sameSpaceValue(entry.block.content, next.block.content))
      )
        continue;
      return false;
    }
    if (
      !next ||
      !sameSpaceValue(entry.block.content, next.block.content) ||
      entry.block.type !== next.block.type ||
      entry.block.version !== next.block.version
    )
      return false;
  }
  return batch.mutations.every(
    (mutation) =>
      mutation.kind !== "replace" ||
      isKnownSpaceBlock(mutation.block) ||
      isSpaceTabsBlock(mutation.block) ||
      isSpaceTabPaneBlock(mutation.block) ||
      isSpaceSyncedBlock(mutation.block) ||
      isSpaceSyncedRef(mutation.block) ||
      (isSpaceDatabaseBlock(mutation.block) &&
        isSameSpaceDatabaseBlock(
          mutation.block,
          before.find((entry) => entry.block.id === mutation.block.id)?.block ?? mutation.block,
        )) ||
      sameSpaceValue(
        before.find((entry) => entry.block.id === mutation.block.id)?.block,
        mutation.block,
      ),
  );
}
