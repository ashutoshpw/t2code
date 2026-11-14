import { RegistryContext } from "@effect/atom-react";
import { useContext, useState, type ReactNode } from "react";
import type { SpaceBlockId } from "@t2code/contracts/spaces";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";

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
import { toastManager } from "~/components/ui/toast";
import type { Latest } from "../databases/data/latest";
import type { SpaceDocumentController } from "../documentController";
import type { SyncedHost } from "./SyncedContext";
import { unsyncCopies } from "./syncedActions";

/** What the hosting page offers its synced blocks, plus the confirmation they share. */
export function useSyncedHost(
  controller: SpaceDocumentController,
  latest: Latest<{
    readonly current: () => boolean;
    readonly onOpenSource: (target: SpacePageNavigationTarget) => void;
  }>,
) {
  const registry = useContext(RegistryContext);
  const [confirming, setConfirming] = useState<SpaceBlockId | null>(null);
  const { environmentId, pageId } = controller.session.key;
  const [host] = useState<SyncedHost>(() => ({
    environmentId,
    pageId,
    openPage: (target) => {
      const { current, onOpenSource } = latest.get();
      if (current()) onOpenSource(target);
    },
    hostClean: () => {
      const state = controller.session.getSnapshot();
      return !state.dirty && !state.pending;
    },
    saveHost: () => controller.save(),
    refreshHost: () => controller.refresh(),
    confirmUnsyncAll: setConfirming,
  }));
  const unsyncAll = async (blockId: SpaceBlockId) => {
    try {
      if (!host.hostClean()) await host.saveHost();
      await unsyncCopies(registry, environmentId, blockId);
      await host.refreshHost();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't unsync the copies",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  const dialog: ReactNode = (
    <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Unsync every copy?</AlertDialogTitle>
          <AlertDialogDescription>
            Each copy becomes ordinary blocks on its page and stops following this block.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <AlertDialogClose
            render={<Button variant="destructive" />}
            onClick={() => confirming !== null && void unsyncAll(confirming)}
          >
            Unsync all
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
  return { host, dialog };
}
