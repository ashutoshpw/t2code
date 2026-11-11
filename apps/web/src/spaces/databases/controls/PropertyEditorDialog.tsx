import type { SpacePropertyId } from "@t2code/contracts/spaces";

import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { PropertyEditor } from "./PropertyEditor";

/** The property editor outside the Properties popover: the header menu and a new property. */
export function PropertyEditorDialog({
  propertyId,
  open,
  onOpenChange,
}: {
  readonly propertyId: SpacePropertyId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit property</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <PropertyEditor propertyId={propertyId} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
