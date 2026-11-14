import type { Editor } from "@tiptap/core";
import type { Command } from "@tiptap/pm/state";
import { CopyIcon, MessageSquarePlusIcon, Trash2Icon } from "lucide-react";
import type { SpaceBlockId } from "@t2code/contracts/spaces";

import {
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import { MoveBlockItems } from "./databases/blocks/MoveBlockItems";
import type { SpaceEditorAdapter } from "./adapter";
import { TURN_INTO, canTurnInto, runTurnInto } from "./spaceEditorSupport";
import { SyncedHandleItems } from "./synced/SyncedHandleItems";

/** The block handle menu for every block that is not a database. New block items go here. */
export function SpaceBlockHandleItems({
  editor,
  adapter,
  editable,
  blockId,
  can,
  run,
  media,
  blockType,
  convertible,
  mediaEditable,
  canMove,
  onMoveTo,
  onComment,
}: {
  readonly editor: Editor;
  readonly adapter: SpaceEditorAdapter;
  readonly editable: boolean;
  readonly blockId: SpaceBlockId;
  readonly can: (command: Command) => boolean;
  readonly run: (command: Command) => void;
  readonly media: boolean;
  readonly blockType: string | null;
  readonly convertible: boolean;
  readonly mediaEditable: boolean;
  readonly canMove: boolean;
  readonly onMoveTo: () => void;
  readonly onComment: (() => void) | null;
}) {
  return (
    <>
      {onComment ? (
        <>
          <MenuItem onClick={onComment}>
            <MessageSquarePlusIcon />
            Comment
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      {convertible ? (
        <MenuSub>
          <MenuSubTrigger>Turn into</MenuSubTrigger>
          <MenuSubPopup>
            {TURN_INTO.map((entry) => (
              <MenuItem
                key={entry.key}
                disabled={!can((state) => canTurnInto(adapter, state, blockId, entry))}
                onClick={() => runTurnInto(editor, editable, adapter, blockId, entry)}
              >
                <entry.icon />
                {entry.label}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      ) : null}
      <SyncedHandleItems
        editor={editor}
        adapter={adapter}
        blockId={blockId}
        blockType={blockType}
        can={can}
        run={run}
      />
      {blockType === "synced_block" ? null : (
        <MenuItem
          disabled={!can(adapter.duplicate(blockId))}
          onClick={() => run(adapter.duplicate(blockId))}
        >
          <CopyIcon />
          Duplicate
        </MenuItem>
      )}
      <MoveBlockItems adapter={adapter} blockId={blockId} can={can} run={run} />
      {canMove ? <MenuItem onClick={onMoveTo}>Move to…</MenuItem> : null}
      <MenuSeparator />
      <MenuItem
        variant="destructive"
        disabled={
          !(media
            ? mediaEditable && can(adapter.removeMedia(blockId))
            : can(adapter.remove(blockId)))
        }
        onClick={() => run(media ? adapter.removeMedia(blockId) : adapter.remove(blockId))}
      >
        <Trash2Icon />
        {media ? "Remove media block" : "Delete block"}
      </MenuItem>
    </>
  );
}
