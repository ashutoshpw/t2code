import type { Command } from "@tiptap/pm/state";
import type { SpaceBlockId } from "@t2code/contracts/spaces";

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
import type { SpaceEditorAdapter } from "../../adapter";

function DeleteDatabaseDialog({
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
          <AlertDialogTitle>Delete this database?</AlertDialogTitle>
          <AlertDialogDescription>
            Its rows will no longer be reachable. Undo brings it back until you leave this page.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <AlertDialogClose render={<Button variant="destructive" />} onClick={onConfirm}>
            Delete database
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Opens once the handle menu finished closing; its inert layer would swallow clicks before. */
export function DatabaseDeleteHost({
  request,
  adapter,
  run,
  onClose,
}: {
  readonly request: { readonly id: SpaceBlockId; readonly open: boolean } | null;
  readonly adapter: SpaceEditorAdapter;
  readonly run: (command: Command) => void;
  readonly onClose: () => void;
}) {
  return (
    <DeleteDatabaseDialog
      open={request?.open === true}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onConfirm={() => {
        if (request !== null) run(adapter.removeDatabase(request.id));
      }}
    />
  );
}
