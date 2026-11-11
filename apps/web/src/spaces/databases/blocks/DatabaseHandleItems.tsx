import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from "lucide-react";
import type { Command } from "@tiptap/pm/state";
import type { SpaceBlockId } from "@t2code/contracts/spaces";

import { MenuItem, MenuSeparator } from "~/components/ui/menu";
import type { SpaceEditorAdapter } from "../../adapter";

/** Move up and Move down, shared by every block handle menu. */
export function MoveBlockItems({
  adapter,
  blockId,
  can,
  run,
}: {
  readonly adapter: SpaceEditorAdapter;
  readonly blockId: SpaceBlockId;
  readonly can: (command: Command) => boolean;
  readonly run: (command: Command) => void;
}) {
  return (
    <>
      <MenuItem
        disabled={!can(adapter.shift(-1, blockId))}
        onClick={() => run(adapter.shift(-1, blockId))}
      >
        <ArrowUpIcon />
        Move up
      </MenuItem>
      <MenuItem
        disabled={!can(adapter.shift(1, blockId))}
        onClick={() => run(adapter.shift(1, blockId))}
      >
        <ArrowDownIcon />
        Move down
      </MenuItem>
    </>
  );
}

/** The block handle menu of a database block: move and delete only. */
export function DatabaseHandleItems({
  adapter,
  blockId,
  can,
  run,
  onDelete,
}: {
  readonly adapter: SpaceEditorAdapter;
  readonly blockId: SpaceBlockId;
  readonly can: (command: Command) => boolean;
  readonly run: (command: Command) => void;
  /** The confirmation lives outside the menu popup, which unmounts when the menu closes. */
  readonly onDelete: (blockId: SpaceBlockId) => void;
}) {
  return (
    <>
      <MoveBlockItems adapter={adapter} blockId={blockId} can={can} run={run} />
      <MenuSeparator />
      <MenuItem
        variant="destructive"
        disabled={!can(adapter.removeDatabase(blockId))}
        onClick={() => onDelete(blockId)}
      >
        <Trash2Icon />
        Delete database
      </MenuItem>
    </>
  );
}
