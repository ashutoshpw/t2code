import {
  ReactMarkViewRenderer,
  ReactNodeViewRenderer,
  type ReactNodeViewRendererOptions,
} from "@tiptap/react";
import { Mark as TiptapMark, Node as TiptapNode, type Extensions } from "@tiptap/core";
import { createContext } from "react";

import { spaceAtomNodeView } from "./databases/blocks/nodeView";
import type { SpaceEditorAdapter } from "./adapter";
import { SpaceMediaView } from "./SpaceAtomView";
import { SpaceMentionView } from "./SpaceMentionControls";
import { SpaceCalloutView } from "./SpaceCalloutView";
import { SpaceCodeBlockView } from "./SpaceCodeBlockView";
import { SpaceTabsView } from "./tabs/SpaceTabsView";
import { SyncedBlockView } from "./synced/SyncedBlockView";
import { SyncedRefView } from "./synced/SyncedRefView";

/** Node views that write to the page (callout icon, code language) reach the adapter here. */
export const SpaceEditorAdapterContext = createContext<SpaceEditorAdapter | null>(null);

const insideTarget =
  (selector: string): ReactNodeViewRendererOptions["stopEvent"] =>
  ({ event }) =>
    event.target instanceof Element && !!event.target.closest(selector);

/** Later stages register their node views here and nowhere else. */
export function withSpaceNodeViews(extensions: Extensions): Extensions {
  return extensions.map((extension) => {
    if (!(extension instanceof TiptapNode) && !(extension instanceof TiptapMark)) return extension;
    if (extension instanceof TiptapMark)
      return ["space_page_mention", "space_block_mention"].includes(extension.name)
        ? extension.extend({ addMarkView: () => ReactMarkViewRenderer(SpaceMentionView) })
        : extension;
    switch (extension.name) {
      case "spaceAtom":
        return extension.extend({ addNodeView: () => spaceAtomNodeView() });
      case "spaceMedia":
        return extension.extend({ addNodeView: () => ReactNodeViewRenderer(SpaceMediaView) });
      case "callout":
        return extension.extend({
          addNodeView: () =>
            ReactNodeViewRenderer(SpaceCalloutView, {
              stopEvent: insideTarget("[data-space-callout-icon]"),
            }),
        });
      case "code":
        return extension.extend({
          addNodeView: () =>
            ReactNodeViewRenderer(SpaceCodeBlockView, {
              stopEvent: insideTarget(".chat-markdown-codeblock-header"),
            }),
        });
      case "tabs":
        return extension.extend({
          addNodeView: () =>
            ReactNodeViewRenderer(SpaceTabsView, {
              stopEvent: insideTarget("[data-space-tab-strip]"),
            }),
        });
      case "syncedBlock":
        return extension.extend({
          addNodeView: () =>
            ReactNodeViewRenderer(SyncedBlockView, {
              stopEvent: insideTarget("[data-space-synced-header]"),
            }),
        });
      case "syncedRef":
        return extension.extend({
          addNodeView: () =>
            ReactNodeViewRenderer(SyncedRefView, {
              stopEvent: () => true,
              ignoreMutation: () => true,
            }),
        });
      default:
        return extension;
    }
  });
}
