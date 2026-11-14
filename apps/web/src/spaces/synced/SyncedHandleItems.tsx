import { RegistryContext } from "@effect/atom-react";
import type { Editor } from "@tiptap/core";
import type { Command } from "@tiptap/pm/state";
import { RefreshCcwIcon, UnlinkIcon } from "lucide-react";
import { useContext } from "react";
import { isSpaceSyncedRef } from "@t2code/client-runtime/spaces";
import type { SpaceBlockId } from "@t2code/contracts/spaces";

import { MenuItem } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import type { SpaceEditorAdapter } from "../adapter";
import { entries } from "../adapterModel";
import { copySyncedMarker, unsyncCopies } from "./syncedActions";
import { wrapInSynced } from "./syncedCommands";
import { SyncedHostContext } from "./SyncedContext";

/** Handle menu entries for synced blocks; render nothing where the environment has none. */
export function SyncedHandleItems({
  editor,
  adapter,
  blockId,
  blockType,
  can,
  run,
}: {
  readonly editor: Editor;
  readonly adapter: SpaceEditorAdapter;
  readonly blockId: SpaceBlockId;
  readonly blockType: string | null;
  readonly can: (command: Command) => boolean;
  readonly run: (command: Command) => void;
}) {
  const host = useContext(SyncedHostContext);
  const registry = useContext(RegistryContext);
  if (!host) return null;
  const sourceOf = () => {
    const block = entries(editor.state.doc).find((item) => item.block.id === blockId)?.block;
    return block && isSpaceSyncedRef(block) ? block.content.sourceBlockId : null;
  };
  const attempt = (title: string, action: () => Promise<unknown>) =>
    void action().catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title,
        description: error instanceof Error ? error.message : undefined,
      }),
    );
  const saveHost = async () => {
    if (!host.hostClean()) await host.saveHost();
  };
  const copyAndSync = async () => {
    const source = blockType === "synced_ref" ? sourceOf() : blockId;
    if (source === null) return;
    await saveHost();
    await copySyncedMarker(host.environmentId, source);
  };
  const wrapAndCopy = async () => {
    let created: SpaceBlockId | null = null;
    run(wrapInSynced(adapter, blockId, (id) => (created = id)));
    if (created === null) return;
    await host.saveHost();
    await copySyncedMarker(host.environmentId, created);
  };
  const unsync = async () => {
    const source = sourceOf();
    if (source === null) return;
    await saveHost();
    await unsyncCopies(registry, host.environmentId, source, [blockId]);
    await host.refreshHost();
  };
  if (blockType === "synced_block")
    return (
      <>
        <MenuItem onClick={() => attempt("Couldn't copy the synced block", copyAndSync)}>
          <RefreshCcwIcon />
          Copy and sync
        </MenuItem>
        <MenuItem onClick={() => host.confirmUnsyncAll(blockId)}>
          <UnlinkIcon />
          Unsync all
        </MenuItem>
      </>
    );
  if (blockType === "synced_ref")
    return (
      <>
        <MenuItem onClick={() => attempt("Couldn't copy the synced block", copyAndSync)}>
          <RefreshCcwIcon />
          Copy and sync
        </MenuItem>
        <MenuItem onClick={() => attempt("Couldn't unsync this copy", unsync)}>
          <UnlinkIcon />
          Unsync
        </MenuItem>
      </>
    );
  return can(wrapInSynced(adapter, blockId)) ? (
    <MenuItem onClick={() => attempt("Couldn't sync the block", wrapAndCopy)}>
      <RefreshCcwIcon />
      Copy and sync
    </MenuItem>
  ) : null;
}
