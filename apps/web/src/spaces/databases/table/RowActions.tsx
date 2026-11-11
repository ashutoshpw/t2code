import { useRouter } from "@tanstack/react-router";
import { ExpandIcon, LinkIcon, MoreHorizontalIcon, PanelRightIcon, Trash2Icon } from "lucide-react";
import { memo } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageId } from "@t2code/contracts/spaces";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import type { GridHandlers } from "./tableTypes";

function CopyLinkItem({
  environmentId,
  spaceId,
  pageId,
}: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: string;
  readonly pageId: string;
}) {
  const router = useRouter();
  return (
    <MenuItem
      onClick={() => {
        const href = router.buildLocation({
          to: "/spaces/$environmentId/$spaceId/$pageId",
          params: { environmentId, spaceId, pageId },
        }).href;
        void navigator.clipboard.writeText(new URL(href, window.location.origin).toString()).then(
          () => toastManager.add({ type: "success", title: "Link copied" }),
          () => toastManager.add({ type: "error", title: "Couldn't copy link" }),
        );
      }}
    >
      <LinkIcon />
      Copy link
    </MenuItem>
  );
}

const REVEAL =
  "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100";
const BUTTON =
  "inline-flex h-5 items-center justify-center gap-1 rounded-sm border bg-background px-1 text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** Open and the row menu on the title cell; visible on row hover or focus. */
export const RowActions = memo(function RowActions({
  pageId,
  spaceId,
  environmentId,
  canTrash,
  grid,
}: {
  readonly pageId: SpacePageId;
  readonly spaceId: string;
  readonly environmentId: EnvironmentId;
  readonly canTrash: boolean;
  readonly grid: GridHandlers;
}) {
  return (
    <span className="ms-auto flex shrink-0 items-center gap-0.5 ps-1">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Open row"
        className={`${BUTTON} ${REVEAL}`}
        onClick={(event) => {
          event.stopPropagation();
          grid.open(pageId);
        }}
      >
        <ExpandIcon className="size-3" />
        Open
      </button>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Row actions"
              tabIndex={-1}
              className={`${BUTTON} w-5 ${REVEAL}`}
              onClick={(event) => event.stopPropagation()}
            />
          }
        >
          <MoreHorizontalIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => grid.open(pageId, "side_peek")}>
            <PanelRightIcon />
            Open in side peek
          </MenuItem>
          <MenuItem onClick={() => grid.open(pageId, "full_page")}>
            <ExpandIcon />
            Open as full page
          </MenuItem>
          <CopyLinkItem environmentId={environmentId} spaceId={spaceId} pageId={pageId} />
          {canTrash ? (
            <MenuItem variant="destructive" onClick={() => grid.trash(pageId)}>
              <Trash2Icon />
              Delete
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    </span>
  );
});
