import { EyeIcon, EyeOffIcon, Trash2Icon } from "lucide-react";
import type { Command } from "@tiptap/pm/state";
import type { SpaceBlockId, SpaceDatabaseId } from "@t2code/contracts/spaces";

import { MenuItem, MenuSeparator } from "~/components/ui/menu";
import { useEnvironment } from "../../../state/environments";
import type { SpaceEditorAdapter } from "../../adapter";
import { useDatabaseBlockHost } from "./DatabaseBlockHost";
import { MoveBlockItems } from "./MoveBlockItems";
import { useIsLinkedBlock } from "./useIsLinkedBlock";

/** The block handle menu of a database block: title visibility, move and delete. */
export function DatabaseHandleItems({
  adapter,
  blockId,
  databaseId,
  titleHidden,
  can,
  run,
  onDelete,
}: {
  readonly adapter: SpaceEditorAdapter;
  readonly blockId: SpaceBlockId;
  readonly databaseId: SpaceDatabaseId;
  readonly titleHidden: boolean;
  readonly can: (command: Command) => boolean;
  readonly run: (command: Command) => void;
  /** The confirmation lives outside the menu popup, which unmounts when the menu closes. */
  readonly onDelete: (blockId: SpaceBlockId) => void;
}) {
  // A linked view is an ordinary block: deleting it keeps the database, so no confirmation.
  const linked = useIsLinkedBlock(blockId, databaseId);
  const hideable =
    useEnvironment(useDatabaseBlockHost()?.environmentId ?? null)?.serverConfig?.environment
      .capabilities.spaces?.features?.databaseHideTitle === true;
  const toggleTitle = adapter.setDatabaseTitleHidden(blockId, !titleHidden);
  return (
    <>
      {hideable ? (
        <>
          <MenuItem disabled={!can(toggleTitle)} onClick={() => run(toggleTitle)}>
            {titleHidden ? <EyeIcon /> : <EyeOffIcon />}
            {titleHidden ? "Show title" : "Hide title"}
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
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
