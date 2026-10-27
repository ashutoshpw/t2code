import { createContext, useContext, type ReactNode } from "react";
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from "@tiptap/react";
import type { SpaceBlock } from "@t2code/contracts/spaces";
import { isKnownSpaceBlock } from "@t2code/client-runtime/spaces";

export const SpaceAtomContext = createContext<
  ((block: SpaceBlock, captionInEditor?: boolean) => ReactNode) | undefined
>(undefined);
export function SpaceAtomView({ node }: NodeViewProps) {
  const renderChild = useContext(SpaceAtomContext);
  const block = node.attrs.block as SpaceBlock;
  return (
    <NodeViewWrapper contentEditable={false} data-space-block={block.id}>
      {isKnownSpaceBlock(block) &&
      ["child_page", "image", "pdf", "video"].includes(block.type) &&
      renderChild ? (
        renderChild(block)
      ) : isKnownSpaceBlock(block) && block.type === "divider" ? (
        <hr />
      ) : (
        `${block.type} (read only)`
      )}
    </NodeViewWrapper>
  );
}

export const SpaceMediaWritableContext = createContext(false);
export function SpaceMediaView({ node }: NodeViewProps) {
  const renderMedia = useContext(SpaceAtomContext);
  const writable = useContext(SpaceMediaWritableContext);
  const block = node.attrs.block as SpaceBlock;
  return (
    <NodeViewWrapper as="figure" data-space-block={block.id}>
      <div contentEditable={false}>{renderMedia?.(block, true)}</div>
      <NodeViewContent<"figcaption">
        as="figcaption"
        aria-label="Media caption"
        contentEditable={writable}
      />
    </NodeViewWrapper>
  );
}
