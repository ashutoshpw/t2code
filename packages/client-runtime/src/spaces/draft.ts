import * as Schema from "effect/Schema";
import { NonNegativeInt } from "@t2code/contracts";
import {
  SpaceBlock,
  SpaceBlockId,
  SpaceBlockMutation,
  SpacePageTarget,
  SpaceReceiptEpoch,
} from "@t2code/contracts/spaces";
import type { SpaceDocumentDraft } from "./session.ts";
import { savedHistorySchema, validateSavedHistory } from "./savedHistory.ts";

const requestSchema = Schema.Struct({
  key: SpacePageTarget,
  mutationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  receiptEpoch: Schema.optionalKey(SpaceReceiptEpoch),
  baseRevision: NonNegativeInt,
  generation: NonNegativeInt,
  mutations: Schema.Array(SpaceBlockMutation),
});
const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.Literal(1),
    key: SpacePageTarget,
    baseRevision: NonNegativeInt,
    generation: NonNegativeInt,
    memberIds: Schema.Array(SpaceBlockId),
    blocks: Schema.Array(SpaceBlock),
    mutations: Schema.Array(SpaceBlockMutation),
    pending: Schema.NullOr(requestSchema),
    history: Schema.optionalKey(savedHistorySchema),
  }),
  { onExcessProperty: "error" },
);

export const spaceDraftMaxBytes = 2 * 1024 * 1024;

export function spaceJsonBytes(value: unknown, maximum: number): number {
  const queue = [{ value, depth: 0 }];
  let nodes = 0;
  while (queue.length) {
    const item = queue.pop()!;
    if (++nodes > maximum || item.depth > 128) throw new Error("Spaces JSON exceeds limits");
    const v = item.value;
    if (v === null || typeof v === "string" || typeof v === "boolean") continue;
    if (typeof v === "number" && Number.isFinite(v)) continue;
    if (
      typeof v !== "object" ||
      (!Array.isArray(v) &&
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null)
    )
      throw new Error("Spaces data must be JSON");
    const values = Object.values(v);
    if (values.length + queue.length > maximum) throw new Error("Spaces JSON exceeds limits");
    for (const child of values) queue.push({ value: child, depth: item.depth + 1 });
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > maximum) throw new Error("Spaces JSON exceeds byte limit");
  return bytes;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const entries = Object.entries(a);
  return (
    entries.length === Object.keys(b).length &&
    entries.every(([k, v]) => Object.hasOwn(b, k) && same(v, Reflect.get(b, k)))
  );
}

export function decodeSpaceDocumentDraft(
  value: unknown,
  key: SpacePageTarget,
  limits = { maxLoadedBlocks: 100, maxMutations: 100 },
): SpaceDocumentDraft {
  spaceJsonBytes(value, spaceDraftMaxBytes);
  let draft: SpaceDocumentDraft;
  try {
    draft = decode(value);
  } catch {
    throw new Error("Invalid Spaces draft; stored data has been retained");
  }
  if (!same(draft.key, key)) throw new Error("Draft belongs to another document");
  if (
    !Number.isSafeInteger(draft.baseRevision) ||
    !Number.isSafeInteger(draft.generation) ||
    draft.blocks.length > limits.maxLoadedBlocks ||
    draft.memberIds.length > limits.maxLoadedBlocks ||
    draft.mutations.length > limits.maxMutations ||
    (draft.mutations.length > 0 && draft.generation === 0)
  )
    throw new Error("Draft exceeds session limits");
  const live = new Set(draft.memberIds);
  const reserved = new Set(live);
  const changed = new Map<string, SpaceBlock>();
  if (live.size !== draft.memberIds.length) throw new Error("Duplicate draft member");
  for (const mutation of draft.mutations) {
    const id = mutation.kind === "delete" ? mutation.blockId : mutation.block.id;
    if (mutation.kind === "insert") {
      if (reserved.has(id)) throw new Error("Invalid draft insertion");
      reserved.add(id);
      live.add(id);
    } else if (!live.has(id)) throw new Error("Draft targets an unloaded block");
    if (mutation.kind === "delete") {
      if (mutation.mergedInto && (mutation.mergedInto === id || !live.has(mutation.mergedInto)))
        throw new Error("Invalid draft merge");
      live.delete(id);
      changed.delete(id);
    } else changed.set(id, mutation.block);
  }
  if (
    draft.blocks.length !== live.size ||
    new Set(draft.blocks.map((b) => b.id)).size !== live.size ||
    draft.blocks.some(
      (b) =>
        !live.has(b.id) ||
        (b.parentId !== null && reserved.has(b.parentId) && !live.has(b.parentId)) ||
        (changed.has(b.id) && !same(changed.get(b.id), b)),
    )
  )
    throw new Error("Draft content does not match its mutations");
  const pending = draft.pending;
  if (
    pending &&
    (!same(pending.key, key) ||
      pending.baseRevision !== draft.baseRevision ||
      !Number.isSafeInteger(pending.generation) ||
      pending.generation < 1 ||
      pending.generation > draft.generation ||
      pending.mutations.length === 0 ||
      pending.mutations.length > draft.mutations.length ||
      !pending.mutations.every((m, i) => same(m, draft.mutations[i])) ||
      (pending.mutations.length < draft.mutations.length &&
        pending.generation === draft.generation))
  )
    throw new Error("Invalid pending draft prefix or generation");
  if (draft.history) validateSavedHistory(draft.history, limits.maxLoadedBlocks, draft);
  return draft;
}
