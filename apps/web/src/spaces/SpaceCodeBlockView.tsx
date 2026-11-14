import {
  NodeViewContent,
  NodeViewWrapper,
  useEditorState,
  type NodeViewProps,
} from "@tiptap/react";
import { CheckIcon, CopyIcon, WrapTextIcon } from "lucide-react";
import { useContext, useState } from "react";
import type { SpaceBlock } from "@t2code/contracts/spaces";

import { MarkdownCodeBlockFrame } from "~/components/chat/MarkdownCodeBlock";
import { ComposerCodeBlockLanguagePicker } from "~/components/chat/ComposerCodeBlockLanguagePicker";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { getClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { runCommand } from "./spaceEditorSupport";
import { SpaceEditorAdapterContext } from "./spaceNodeViews";
import { spaceCodeLanguage } from "./spaceCodeHighlight";

export function SpaceCodeBlockView({ node, editor, getPos }: NodeViewProps) {
  const adapter = useContext(SpaceEditorAdapterContext);
  const theme = useRenderedAppearance();
  const block = node.attrs.block as SpaceBlock;
  const language = spaceCodeLanguage(block);
  const writable = useEditorState({ editor, selector: ({ editor }) => editor.isEditable });
  // Wrapping is a per-viewer reading preference and is never written to the page.
  const [wrapped, setWrapped] = useState(() => getClientSettings().wordWrap);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1200 });
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copyLabel = isCopied ? "Copied" : "Copy code";

  const changeLanguage = (next: string) => {
    if (!adapter) return;
    runCommand(editor, true, adapter.setCodeLanguage(block.id, next));
    const position = getPos();
    if (typeof position === "number")
      editor
        .chain()
        .focus(position + 1 + node.content.size)
        .run();
  };

  return (
    <NodeViewWrapper data-space-block={block.id}>
      <MarkdownCodeBlockFrame
        language={language || "text"}
        fenceTitle={null}
        theme={theme}
        wrapped={wrapped}
        headerProps={{ contentEditable: false }}
        title={
          <ComposerCodeBlockLanguagePicker
            language={language}
            theme={theme}
            disabled={!writable || !adapter}
            onChange={changeLanguage}
          />
        }
        actions={
          <span
            className="flex items-center gap-0.5"
            role="toolbar"
            aria-label="Code block actions"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant={wrapped ? "secondary" : "ghost-muted"}
                    size="icon-xs"
                    aria-pressed={wrapped}
                    onClick={() => setWrapped((value) => !value)}
                    aria-label={wrapLabel}
                  />
                }
              >
                <WrapTextIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="icon-xs"
                    onClick={() => copyToClipboard(node.textContent)}
                    aria-label={copyLabel}
                  />
                }
              >
                {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              </TooltipTrigger>
              <TooltipPopup side="top">{copyLabel}</TooltipPopup>
            </Tooltip>
          </span>
        }
      >
        <div className="chat-markdown-shiki">
          <pre
            className={
              wrapped ? "max-w-full px-3 pt-1 pb-2" : "max-w-full overflow-x-auto px-3 pt-1 pb-2"
            }
          >
            <NodeViewContent<"code">
              as="code"
              className={
                wrapped
                  ? "block min-h-[1lh] font-mono whitespace-pre-wrap text-inherit [overflow-wrap:anywhere]"
                  : "block min-h-[1lh] font-mono whitespace-pre text-inherit"
              }
            />
          </pre>
        </div>
      </MarkdownCodeBlockFrame>
    </NodeViewWrapper>
  );
}
