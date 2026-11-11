import { EnvironmentId } from "@t2code/contracts";
import type { SpaceBlockId, SpaceBlockWindow, SpacePageId } from "@t2code/contracts/spaces";

import { SpaceEditorAdapter } from "~/spaces/adapter";

/** An editor adapter that can show a window of blocks and refuses every change. */
export function staticAdapter(pageId: SpacePageId, window: SpaceBlockWindow) {
  const refuse = (): never => {
    throw new Error("Shared pages are read only");
  };
  return new SpaceEditorAdapter({
    target: { environmentId: EnvironmentId.make("shared"), pageId },
    window: {
      ...window,
      completeParents: [null, ...window.blocks.map((block) => block.id)],
    },
    maxBlocks: Math.max(window.blocks.length, 1),
    maxDepth: 64,
    maxTextLength: 1_000_000,
    maxClipboardBytes: 1_000_000,
    allocateId: () => refuse() as SpaceBlockId,
    allocateOrder: refuse,
    canEdit: () => false,
    canChangeStructure: () => false,
    canUndo: () => false,
    canEditMedia: () => false,
  });
}
