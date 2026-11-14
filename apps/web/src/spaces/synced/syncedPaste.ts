import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { Command } from "@tiptap/pm/state";
import { parseSyncedClipboard } from "@t2code/client-runtime/spaces";

import type { SpaceEditorAdapter } from "../adapter";
import { selectedBlock } from "../spaceEditorSupport";
import { insertSyncedRef } from "./syncedCommands";

/**
 * The command a pasted "Copy and sync" marker runs: a copy after the caret block. Null for any
 * other text or another environment's marker, which paste as ordinary text.
 */
export function syncedPasteCommand(adapter: SpaceEditorAdapter, text: string): Command | null {
  const sourceBlockId = parseSyncedClipboard(text, adapter.target.environmentId);
  if (sourceBlockId === null) return null;
  return (state, dispatch) =>
    insertSyncedRef(adapter, selectedBlock(state)?.id ?? null, sourceBlockId)(state, dispatch);
}

/** Registered ahead of the adapter's own paste handling; a refused placement falls through to text. */
export function syncedPasteExtension(adapter: SpaceEditorAdapter) {
  return Extension.create({
    name: "spaceSyncedPaste",
    priority: 1000,
    addProseMirrorPlugins: () => [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            const command = syncedPasteCommand(
              adapter,
              event.clipboardData?.getData("text/plain") ?? "",
            );
            return command !== null && command(view.state, view.dispatch);
          },
        },
      }),
    ],
  });
}
