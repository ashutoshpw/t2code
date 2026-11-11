import { Trash2Icon } from "lucide-react";
import type { Command } from "@tiptap/pm/state";
import type { SpaceBlockId, SpaceDatabaseId } from "@t2code/contracts/spaces";

import { MenuItem, MenuSeparator } from "~/components/ui/menu";
import type { SpaceEditorAdapter } from "../../adapter";
import { MoveBlockItems } from "./MoveBlockItems";
import { useIsLinkedBlock } from "./useIsLinkedBlock";

/** The block handle menu of a database block: move and delete only. */
export function DatabaseHandleItems({
  adapter,
  blockId,
  databaseId,
  can,
  run,
  onDelete,
}: {
  readonly adapter: SpaceEditorAdapter;
  readonly blockId: SpaceBlockId;
  readonly databaseId: SpaceDatabaseId;
  readonly can: (command: Command) => boolean;
  readonly run: (command: Command) => void;
  /** The confirmation lives outside the menu popup, which unmounts when the menu closes. */
  readonly onDelete: (blockId: SpaceBlockId) => void;
}) {
  // A linked view is an ordinary block: deleting it keeps the database, so no confirmation.
  const linked = useIsLinkedBlock(blockId, databaseId);
  return (
    <>
      <MoveBlockItems adapter={adapter} blockId={blockId} can={can} run={run} />
      <MenuSeparator />
      <MenuItem
        variant="destructive"
        disabled={!can(adapter.removeDatabase(blockId))}
        onClick={() => (linked ? run(adapter.removeDatabase(blockId)) : onDelete(blockId))}
      >
        <Trash2Icon />
        {linked ? "Delete linked view" : "Delete database"}
      </MenuItem>
    </>
  );
}
