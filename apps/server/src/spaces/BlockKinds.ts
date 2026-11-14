import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ensureLimit } from "./CorePolicy.ts";

const strict = { onExcessProperty: "error" } as const;
const knownBlock = Schema.is(C.SpaceKnownBlock);
const strictTabs = Schema.decodeUnknownOption(C.SpaceTabsBlock, strict);
const strictPane = Schema.decodeUnknownOption(C.SpaceTabPaneBlock, strict);
const strictSynced = Schema.decodeUnknownOption(C.SpaceSyncedBlock, strict);
const strictSyncedRef = Schema.decodeUnknownOption(C.SpaceSyncedRefBlock, strict);

export const strictTabsBlock = (block: C.SpaceBlock) => Option.getOrUndefined(strictTabs(block));
export const strictTabPaneBlock = (block: C.SpaceBlock) => Option.getOrUndefined(strictPane(block));

// An empty Struct accepts any object, so unknown content fields are refused by hand.
export const strictSyncedBlock = (block: C.SpaceBlock) => {
  const decoded = Option.getOrUndefined(strictSynced(block));
  return decoded !== undefined && Object.keys(decoded.content).length === 0 ? decoded : undefined;
};
export const strictSyncedRefBlock = (block: C.SpaceBlock) =>
  Option.getOrUndefined(strictSyncedRef(block));

/** Extension kinds (kept out of SpaceKnownBlock) that decode strictly and so have no unknown fields. */
export const extensionBlock = (block: C.SpaceBlock) =>
  block.type === "tabs"
    ? strictTabsBlock(block)
    : block.type === "tab_pane"
      ? strictTabPaneBlock(block)
      : block.type === "synced_block"
        ? strictSyncedBlock(block)
        : block.type === "synced_ref"
          ? strictSyncedRefBlock(block)
          : undefined;

const listContainer = (block: C.SpaceBlock) =>
  C.SPACE_LIST_CONTAINER_TYPES.some((type) => type === block.type) && knownBlock(block);

/** Whether the block may have children: a known list container or a strictly decoded tabs, tab_pane or synced_block. */
export const isContainer = (block: C.SpaceBlock) =>
  listContainer(block) || (block.type !== "synced_ref" && extensionBlock(block) !== undefined);

interface AncestorStep {
  readonly pageId: string;
  readonly parentId: string | null;
  readonly block: C.SpaceBlock;
}

/** Walks up from `parentId` on one page; every ancestor must be a container. Returns types nearest first. */
export const containerAncestry = Effect.fnUntraced(function* <E, R>(
  pageId: string,
  parentId: string | null,
  load: (id: string) => Effect.Effect<AncestorStep, E, R>,
) {
  const seen = new Set<string>();
  const types: string[] = [];
  let current = parentId;
  while (current !== null) {
    if (seen.has(current)) return yield* new C.SpaceValidationError({ reason: "cycle" });
    seen.add(current);
    yield* ensureLimit("maxDepth", seen.size + 1);
    const step = yield* load(current);
    if (step.pageId !== pageId || !isContainer(step.block))
      return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
    types.push(step.block.type);
    current = step.parentId;
  }
  return types;
});
