import { CopyIcon, PencilIcon, Trash2Icon } from "lucide-react";
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
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "~/components/ui/menu";
import type { DatabaseActions } from "../data/actions";
import { isViewType } from "@t2code/client-runtime/spaces";
import { VIEW_REGISTRY, VIEW_TYPES } from "./viewRegistry";

/** Rename, duplicate, layout and delete of the active tab. */
export function ViewTabMenu({
  view,
  deletable,
  actions,
  onRename,
  onDelete,
}: {
  readonly view: SpaceDatabaseView;
  readonly deletable: boolean;
  readonly actions: DatabaseActions;
  readonly onRename: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <>
      <MenuItem onClick={onRename}>
        <PencilIcon />
        Rename
      </MenuItem>
      <MenuItem onClick={() => void actions.duplicateView(view.id)}>
        <CopyIcon />
        Duplicate
      </MenuItem>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>Layout</MenuGroupLabel>
        <MenuRadioGroup
          value={view.type}
          onValueChange={(type) => {
            if (isViewType(type) && type !== view.type) actions.changeViewType(view.id, type);
          }}
        >
          {VIEW_TYPES.map((type) => {
            const { icon: Icon, label } = VIEW_REGISTRY[type];
            return (
              <MenuRadioItem key={type} value={type}>
                <span className="flex items-center gap-2">
                  <Icon className="size-4" />
                  {label}
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem variant="destructive" disabled={!deletable} onClick={onDelete}>
        <Trash2Icon />
        Delete view
      </MenuItem>
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
