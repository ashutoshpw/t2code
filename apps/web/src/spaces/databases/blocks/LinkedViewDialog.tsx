import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDatabaseId, SpaceId } from "@t2code/contracts/spaces";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { DatabasePicker } from "../controls/DatabasePicker";

/** Choose the database a linked view shows; the block starts with no views of its own. */
export function LinkedViewDialog({
  open,
  environmentId,
  spaceId,
  onPick,
  onClose,
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly onPick: (databaseId: SpaceDatabaseId) => void;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Link to a database</DialogTitle>
          <DialogDescription>Show an existing database with views of its own.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <DatabasePicker
            environmentId={environmentId}
            spaceId={spaceId}
            chooseDataSource={false}
            onPick={(picked) => onPick(picked.databaseId)}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
