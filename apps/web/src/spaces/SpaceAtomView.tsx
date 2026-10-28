import { createContext, useContext, type ReactNode } from "react";
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from "@tiptap/react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceBlock, SpacePageId } from "@t2code/contracts/spaces";
import { isKnownSpaceBlock, type SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import { FileTextIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { useEnvironmentQuery } from "../state/query";
import { spacesEnvironment } from "../state/spaces";

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

export function SpaceChildPageRow({
  environmentId,
  pageId,
  current,
  onOpen,
}: {
  environmentId: EnvironmentId;
  pageId: SpacePageId;
  current: () => boolean;
  onOpen: (target: SpacePageNavigationTarget) => void;
}) {
  const query = useEnvironmentQuery(
    spacesEnvironment.page({ environmentId, input: { environmentId, pageId } }),
  );
  const page = query.data?.page;
  return (
    <div className="my-0.5">
      <Button
        variant="ghost"
        className="w-full justify-start"
        disabled={!page || !current()}
        onClick={() => {
          if (page && current()) onOpen({ environmentId, spaceId: page.spaceId, pageId });
        }}
      >
        <FileTextIcon />
        <span className="truncate">{page ? page.title || "Untitled page" : "Loading…"}</span>
      </Button>
    </div>
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
