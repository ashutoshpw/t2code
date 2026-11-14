import {
  CopyIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import { useState, type ReactElement } from "react";
import type { SpaceDatabaseView } from "@t2code/contracts/spaces";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import type { DatabaseActions } from "../data/actions";

/** The "..." menu of one view, with the delete confirmation that outlives the menu. */
export function ViewMenu({
  view,
  deletable,
  actions,
  trigger,
  open,
  onOpenChange,
  onRename,
  onEdit,
  onCopyLink,
}: {
  readonly view: SpaceDatabaseView;
  readonly deletable: boolean;
  readonly actions: DatabaseActions;
  /** The button the menu hangs from; the menu adds its icon. */
  readonly trigger: ReactElement;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onRename: () => void;
  readonly onEdit: () => void;
  readonly onCopyLink: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // The dialog opens once the menu has finished closing, or the menu leaves inert guards over it.
  const [deleteRequested, setDeleteRequested] = useState(false);
  return (
    <>
      <Menu
        {...(open === undefined ? {} : { open })}
        {...(onOpenChange === undefined ? {} : { onOpenChange })}
        onOpenChangeComplete={(next) => {
          if (!next && deleteRequested) {
            setDeleteRequested(false);
            setConfirming(true);
          }
        }}
      >
        <MenuTrigger render={trigger}>
          <MoreHorizontalIcon />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuItem onClick={onRename}>
            <PencilIcon />
            Rename
          </MenuItem>
          <MenuItem onClick={onEdit}>
            <Settings2Icon />
            Edit view
          </MenuItem>
          <MenuItem onClick={onCopyLink}>
            <LinkIcon />
            Copy link to view
          </MenuItem>
          <MenuItem onClick={() => void actions.duplicateView(view.id)}>
            <CopyIcon />
            Duplicate
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            variant="destructive"
            disabled={!deletable}
            onClick={() => setDeleteRequested(true)}
          >
            <Trash2Icon />
            Delete view
          </MenuItem>
        </MenuPopup>
      </Menu>
      <DeleteViewDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => void actions.deleteView(view.id)}
      />
    </>
  );
}

/** Outside the menu popup, which unmounts as soon as an item is chosen. */
export function DeleteViewDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this view?</AlertDialogTitle>
          <AlertDialogDescription>
            The rows stay. The view and its filters, sorts and layout are removed, and this can't be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <AlertDialogClose render={<Button variant="destructive" />} onClick={onConfirm}>
            Delete view
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
