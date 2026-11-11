import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import type { Command } from "@tiptap/pm/state";
import type { SpaceBlockId } from "@t2code/contracts/spaces";

import { MenuItem } from "~/components/ui/menu";
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
