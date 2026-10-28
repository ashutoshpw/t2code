import * as Schema from "effect/Schema";
import { SpaceBlock, type SpaceBlockId } from "@t2code/contracts/spaces";
import { NonNegativeInt } from "@t2code/contracts";
import { canEditSpaceBlock } from "./values.ts";
import { spaceJsonBytes } from "./draft.ts";
import type { SpaceMutation, SpaceDocumentDraft } from "./session.ts";

export type SpaceCompensation = "undo" | "redo";
const changeSchema = Schema.Struct({
  before: Schema.Array(SpaceBlock),
  after: Schema.Array(SpaceBlock),
  revision: NonNegativeInt,
});
export const savedHistorySchema = Schema.Struct({
  base: Schema.NullOr(Schema.Array(SpaceBlock)),
  undo: Schema.NullOr(changeSchema),
  redo: Schema.NullOr(changeSchema),
  action: Schema.NullOr(Schema.Literals(["undo", "redo"])),
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
});
export type SpaceSavedHistory = typeof savedHistorySchema.Type;
const windowBytes = 65536;
const historyBytes = 262144;
const structuralReason = "This change can't be undone from here.";
export const emptySavedHistory: SpaceSavedHistory = {
  base: null,
  undo: null,
  redo: null,
  action: null,
  reason: null,
};

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(
      ([key, value]) => Object.hasOwn(b, key) && same(value, Reflect.get(b, key)),
    )
  );
}
function sameWindow(a: readonly SpaceBlock[], b: readonly SpaceBlock[]) {
  const byId = new Map(a.map((block) => [block.id, block]));
  return a.length === b.length && b.every((block) => same(byId.get(block.id), block));
}
function replaceable(before: readonly SpaceBlock[], after: readonly SpaceBlock[]) {
  const byId = new Map(before.map((block) => [block.id, block]));
  return (
    before.length === after.length &&
    after.every((block) => {
      const old = byId.get(block.id);
      return (
        old &&
        (same(old, block) ||
          (old.parentId === block.parentId &&
            old.order === block.order &&
            old.type !== "child_page" &&
            block.type !== "child_page" &&
            ([old.type, block.type].every((t) => ["image", "pdf", "video"].includes(t)) ||
              ![old.type, block.type].some((t) => ["image", "pdf", "video"].includes(t))) &&
            canEditSpaceBlock(old) &&
            canEditSpaceBlock(block)))
      );
    })
  );
}
function historyWindow(blocks: readonly SpaceBlock[]): readonly SpaceBlock[] | null {
  try {
    spaceJsonBytes(blocks, windowBytes);
    return blocks;
  } catch {
    return null;
  }
}
export function validateSavedHistory(
  history: SpaceSavedHistory,
  maxBlocks: number,
  draft: SpaceDocumentDraft,
) {
  spaceJsonBytes(history, historyBytes);
  for (const blocks of [
    history.base,
    history.undo?.before,
    history.undo?.after,
    history.redo?.before,
    history.redo?.after,
  ]) {
    if (!blocks) continue;
    spaceJsonBytes(blocks, windowBytes);
    if (
      blocks.length > maxBlocks ||
      new Set(blocks.map((block) => block.id)).size !== blocks.length
    )
      throw new Error("Invalid saved history window");
  }
  if ((history.undo && history.redo) || (history.action && !history[history.action]))
    throw new Error("Invalid saved history direction");
  for (const change of [history.undo, history.redo])
    if (
      change &&
      (!replaceable(change.before, change.after) || sameWindow(change.before, change.after))
    )
      throw new Error("Invalid saved content compensation");
  if (history.base) {
    if (
      history.base.length !== draft.memberIds.length ||
      history.base.some((block) => !draft.memberIds.includes(block.id))
    )
      throw new Error("Saved history baseline is not the draft window");
    const live = new Map(history.base.map((block) => [block.id, block]));
    for (const mutation of draft.mutations) {
      if (mutation.kind === "delete") live.delete(mutation.blockId);
      else live.set(mutation.block.id, mutation.block);
    }
    if (!sameWindow([...live.values()], draft.blocks))
      throw new Error("Saved history does not match the draft");
  }
  if (history.action) {
    if (!history.base) throw new Error("Missing saved compensation baseline");
    const plan = savedCompensation(history, history.action, history.base, draft.baseRevision);
    if (
      plan.reason ||
      plan.mutations.length === 0 ||
      !plan.mutations.every((m, i) => same(m, draft.mutations[i]))
    )
      throw new Error("Saved compensation does not match the draft prefix");
    if (draft.pending && draft.pending.mutations.length !== plan.mutations.length)
      throw new Error("Saved compensation does not match the pending request");
  }
}
export function adoptHistoryWindow(
  history: SpaceSavedHistory,
  blocks: readonly SpaceBlock[],
): SpaceSavedHistory {
  return { ...history, base: historyWindow(blocks) };
}
export function acknowledgeSavedHistory(
  history: SpaceSavedHistory,
  mutations: readonly SpaceMutation[],
  revision: number,
  current: readonly SpaceBlock[],
  hasLaterEdits: boolean,
): SpaceSavedHistory {
  let after: readonly SpaceBlock[] | null = null;
  if (history.base) {
    const blocks = new Map(history.base.map((block) => [block.id, block]));
    for (const mutation of mutations) {
      if (mutation.kind === "delete") blocks.delete(mutation.blockId);
      else blocks.set(mutation.block.id, mutation.block);
    }
    after = historyWindow([...blocks.values()]);
  }
  const base = hasLaterEdits ? after : historyWindow(current);
  if (history.action) {
    const change = { ...history[history.action]!, revision };
    return {
      base,
      undo: history.action === "redo" ? change : null,
      redo: history.action === "undo" ? change : null,
      action: null,
      reason: null,
    };
  }
  const reason =
    mutations.some((m) => m.kind !== "replace") ||
    (history.base && after && !replaceable(history.base, after))
      ? structuralReason
      : !history.base || !after
        ? "This change is too large to undo."
        : sameWindow(history.base, after)
          ? "There's nothing to undo."
          : null;
  return {
    base,
    undo: reason ? null : { before: history.base!, after: after!, revision },
    redo: null,
    action: null,
    reason,
  };
}
export function savedCompensation(
  history: SpaceSavedHistory,
  direction: SpaceCompensation,
  blocks: readonly SpaceBlock[],
  revision: number | null,
): { mutations: readonly SpaceMutation[]; reason: string | null } {
  const change = history[direction];
  if (!change)
    return {
      mutations: [],
      reason:
        history.reason ??
        `No saved ${direction} is available. Only the last saved change is retained.`,
    };
  if (change.revision !== revision)
    return {
      mutations: [],
      reason: "The observed page revision changed. Saved history cannot be rebased automatically.",
    };
  const expected = direction === "undo" ? change.after : change.before;
  if (!sameWindow(expected, blocks))
    return {
      mutations: [],
      reason:
        "The loaded content changed. Saved history cannot replace another window or newer draft.",
    };
  const target = direction === "undo" ? change.before : change.after;
  const byId = new Map<SpaceBlockId, SpaceBlock>(blocks.map((block) => [block.id, block]));
  return {
    reason: null,
    mutations: target
      .filter((block) => !same(byId.get(block.id), block))
      .map((block) => ({ kind: "replace", block })),
  };
}
