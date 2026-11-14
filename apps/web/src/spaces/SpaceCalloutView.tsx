import {
  NodeViewContent,
  NodeViewWrapper,
  useEditorState,
  type NodeViewProps,
} from "@tiptap/react";
import { useContext, useState } from "react";
import { isKnownSpaceBlock } from "@t2code/client-runtime/spaces";
import type { SpaceBlock } from "@t2code/contracts/spaces";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { SpaceEmojiPicker } from "./SpaceEmojiPicker";
import { runCommand } from "./spaceEditorSupport";
import { SpaceEditorAdapterContext } from "./spaceNodeViews";

const ICON_CLASS = "absolute start-3.5 top-3 leading-none select-none";

export function SpaceCalloutView({ node, editor }: NodeViewProps) {
  const adapter = useContext(SpaceEditorAdapterContext);
  const [open, setOpen] = useState(false);
  const writable = useEditorState({ editor, selector: ({ editor }) => editor.isEditable });
  const block = node.attrs.block as SpaceBlock;
  const icon = (isKnownSpaceBlock(block) && block.type === "callout" && block.content.icon) || "💡";
  return (
    <NodeViewWrapper
      data-space-block={block.id}
      data-space-type="callout"
      style={{ whiteSpace: "pre-wrap" }}
    >
      <span contentEditable={false} data-space-callout-icon="">
        {writable && adapter ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="Change callout icon"
                  className={`${ICON_CLASS} rounded-md hover:bg-accent`}
                />
              }
            >
              {icon}
            </PopoverTrigger>
            <PopoverPopup align="start" width="md">
              <SpaceEmojiPicker
                onChoose={(next) => {
                  setOpen(false);
                  runCommand(editor, true, adapter.setCalloutIcon(block.id, next));
                }}
              />
            </PopoverPopup>
          </Popover>
        ) : (
          <span className={ICON_CLASS}>{icon}</span>
        )}
      </span>
      <NodeViewContent />
    </NodeViewWrapper>
  );
}
