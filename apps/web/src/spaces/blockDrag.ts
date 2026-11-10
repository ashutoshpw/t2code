import type { SpaceBlock, SpaceBlockId } from "@t2code/contracts/spaces";

export const BLOCK_DRAG_TYPE = "application/x-t2-space-block";

export type BlockDrop = {
  readonly key: string;
  readonly allowed: boolean;
  readonly parentId: SpaceBlockId | null;
  readonly beforeId: SpaceBlockId | null;
  readonly top: number;
  readonly left: number;
  readonly width: number;
};

export function blockElement(wrapper: HTMLElement | null, id: SpaceBlockId | null) {
  return id && wrapper ? wrapper.querySelector(`[data-space-block="${CSS.escape(id)}"]`) : null;
}

export function planBlockDrop(input: {
  readonly blocks: readonly SpaceBlock[];
  readonly dragId: SpaceBlockId;
  readonly targetId: SpaceBlockId;
  readonly after: boolean;
  readonly rect: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly width: number;
  };
  readonly box: { readonly top: number; readonly left: number };
  readonly canMove: (parentId: SpaceBlockId | null, beforeId: SpaceBlockId | null) => boolean;
}): BlockDrop | null {
  const { blocks, dragId, targetId, after, rect, box } = input;
  const target = targetId === dragId ? undefined : blocks.find((block) => block.id === targetId);
  if (!target) return null;
  const siblings = blocks.filter((block) => block.parentId === target.parentId);
  const index = siblings.indexOf(target);
  const beforeId = after ? (siblings[index + 1]?.id ?? null) : targetId;
  const unchanged = siblings[index + (after ? 1 : -1)]?.id === dragId;
  return {
    key: `${targetId}:${after}`,
    allowed: !unchanged && input.canMove(target.parentId, beforeId),
    parentId: target.parentId,
    beforeId,
    top: (after ? rect.bottom : rect.top) - box.top,
    left: rect.left - box.left,
    width: rect.width,
  };
}
