import type {
  SpaceBlock,
  SpaceBlockId,
  SpaceBlockPlacement,
  SpacePageId,
} from "@t2code/contracts/spaces";

export function placementAfterBlock(
  pageId: SpacePageId,
  blocks: readonly Pick<SpaceBlock, "id" | "parentId">[],
  blockId: SpaceBlockId | null,
): SpaceBlockPlacement {
  let top = blocks.find((block) => block.id === blockId);
  while (top?.parentId) {
    const parentId = top.parentId;
    top = blocks.find((block) => block.id === parentId);
  }
  const siblings = blocks.filter((block) => block.parentId === null);
  const next = top ? siblings[siblings.findIndex((block) => block.id === top.id) + 1] : undefined;
  return { pageId, parentId: null, beforeBlockId: next?.id ?? null };
}
