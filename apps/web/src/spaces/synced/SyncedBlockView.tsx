import { useAtomValue } from "@effect/atom-react";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { CopyIcon, RefreshCcwIcon, UnlinkIcon } from "lucide-react";
import { useContext, useState } from "react";
import type { SpaceBlock } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { useEnvironmentQuery } from "~/state/query";
import { spacesEnvironment } from "~/state/spaces";
import { SpacePageGlyph } from "../SpacePageGlyph";
import { runCommand } from "../spaceEditorSupport";
import { SpaceEditorAdapterContext } from "../spaceNodeViews";
import { copySyncedMarker } from "./syncedActions";
import { fillSynced } from "./syncedCommands";
import { SyncedHostContext, type SyncedHost } from "./SyncedContext";

/** Where the copies of this original are; reads only once the popover opens. */
function SyncedPages({ host, blockId }: { host: SyncedHost; blockId: SpaceBlock["id"] }) {
  const { environmentId } = host;
  const query = useEnvironmentQuery(
    spacesEnvironment.readSubtree({ environmentId, input: { environmentId, blockId } }),
  );
  const found = query.data?.status === "found" ? query.data : null;
  if (!found)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {query.error ?? "Loading…"}
      </p>
    );
  if (found.refCount === 0)
    return <p className="text-sm text-muted-foreground">Not copied to another page yet.</p>;
  return (
    <ul className="flex flex-col gap-0.5">
      {found.refs.map((ref) => (
        <li key={ref.blockId}>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() =>
              host.openPage({
                environmentId,
                spaceId: ref.spaceId,
                pageId: ref.pageId,
                blockId: ref.blockId,
              })
            }
          >
            <SpacePageGlyph icon={ref.icon} />
            <span className="truncate">{ref.title || "Untitled page"}</span>
          </Button>
        </li>
      ))}
      {found.refCount > found.refs.length ? (
        <li className="px-2 text-xs text-muted-foreground">
          and {found.refCount - found.refs.length} more
        </li>
      ) : null}
    </ul>
  );
}

function OriginalActions({ host, blockId }: { host: SyncedHost; blockId: SpaceBlock["id"] }) {
  const writable = useAtomValue(spacesEnvironment.unsync.permissionAtom(host.environmentId));
  const [open, setOpen] = useState(false);
  const copyAndSync = async () => {
    if (!host.hostClean()) await host.saveHost();
    await copySyncedMarker(host.environmentId, blockId);
  };
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant="ghost" size="xs" />}>
          Synced to pages
        </PopoverTrigger>
        <PopoverPopup width="sm" align="start">
          {open ? <SyncedPages host={host} blockId={blockId} /> : null}
        </PopoverPopup>
      </Popover>
      <Button
        variant="ghost"
        size="xs"
        onClick={() =>
          void copyAndSync().catch((error: unknown) =>
            toastManager.add({
              type: "error",
              title: "Couldn't copy the synced block",
              description: error instanceof Error ? error.message : undefined,
            }),
          )
        }
      >
        <CopyIcon />
        Copy and sync
      </Button>
      {writable ? (
        <Button variant="ghost" size="xs" onClick={() => host.confirmUnsyncAll(blockId)}>
          <UnlinkIcon />
          Unsync all
        </Button>
      ) : null}
    </>
  );
}

export function SyncedBlockView({ node, editor }: NodeViewProps) {
  const block = node.attrs.block as SpaceBlock;
  const host = useContext(SyncedHostContext);
  const adapter = useContext(SpaceEditorAdapterContext);
  return (
    <NodeViewWrapper data-space-block={block.id} data-space-type="synced_block">
      <div
        contentEditable={false}
        data-space-synced-header=""
        className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
      >
        <RefreshCcwIcon aria-hidden className="size-3" />
        <span>Synced block</span>
        {host ? <OriginalActions host={host} blockId={block.id} /> : null}
      </div>
      <NodeViewContent />
      {node.childCount === 0 && editor.isEditable && adapter ? (
        <Button
          variant="ghost"
          size="xs"
          contentEditable={false}
          onClick={() => runCommand(editor, true, fillSynced(adapter, block.id))}
        >
          Click to write
        </Button>
      ) : null}
    </NodeViewWrapper>
  );
}
