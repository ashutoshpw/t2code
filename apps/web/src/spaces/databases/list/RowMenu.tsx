import {
  ArrowDownIcon,
  ArrowUpIcon,
  CornerDownRightIcon,
  ExpandIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  Trash2Icon,
} from "lucide-react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageId } from "@t2code/contracts/spaces";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { CopyLinkItem } from "../table/RowActions";
import type { RowListHandlers } from "./useRowList";

/** The row menu of list rows and gallery cards: open modes, link, reorder and delete. */
export function RowMenu({
  pageId,
  title,
  spaceId,
  environmentId,
  handlers,
  canTrash,
  canMoveUp,
  canMoveDown,
  className,
}: {
  readonly pageId: SpacePageId;
  readonly title: string;
  readonly spaceId: string;
  readonly environmentId: EnvironmentId;
  readonly handlers: RowListHandlers;
  readonly canTrash: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly className?: string;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Row actions for ${title === "" ? "Untitled" : title}`}
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-sm border bg-background text-muted-foreground opacity-0 outline-none hover:bg-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-popup-open:opacity-100",
              className,
            )}
          />
        }
      >
        <MoreHorizontalIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => handlers.open(pageId, "side_peek")}>
          <PanelRightIcon />
          Open in side peek
        </MenuItem>
        <MenuItem onClick={() => handlers.open(pageId, "full_page")}>
          <ExpandIcon />
          Open as full page
        </MenuItem>
        <CopyLinkItem environmentId={environmentId} spaceId={spaceId} pageId={pageId} />
        <MenuItem disabled={!canMoveUp} onClick={() => handlers.move(pageId, "up")}>
          <ArrowUpIcon />
          Move up
        </MenuItem>
        <MenuItem disabled={!canMoveDown} onClick={() => handlers.move(pageId, "down")}>
          <ArrowDownIcon />
          Move down
        </MenuItem>
        {handlers.canSubItems && canTrash ? (
          <MenuItem onClick={() => handlers.addSubItem(pageId)}>
            <CornerDownRightIcon />
            Add sub-item
          </MenuItem>
        ) : null}
        {canTrash ? (
          <MenuItem variant="destructive" onClick={() => handlers.trash(pageId)}>
            <Trash2Icon />
            Delete
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
