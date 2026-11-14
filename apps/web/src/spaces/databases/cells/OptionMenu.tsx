import type { SpaceDatabaseColor, SpaceOptionId } from "@t2code/contracts/spaces";
import { MoreHorizontalIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { DraftInput } from "~/components/ui/draft-input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Separator } from "~/components/ui/separator";
import { ColorSwatches } from "../primitives/ColorSwatches";
import { useDatabaseActions } from "../shell/context";
import type { Option, OptionKnown } from "./optionRows";

/** Rename, recolor or delete one option from inside the picker. */
export function OptionMenu({
  known,
  option,
}: {
  readonly known: OptionKnown;
  readonly option: Option;
}) {
  const actions = useDatabaseActions();
  const [confirming, setConfirming] = useState(false);
  const optionId = option.id as SpaceOptionId;
  const update = (patch: { name?: string; color?: SpaceDatabaseColor }) =>
    void actions.updateSchema([{ op: "updateOption", propertyId: known.id, optionId, ...patch }]);
  return (
    <Popover onOpenChange={(open) => !open && setConfirming(false)}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-xs"
            tabIndex={-1}
            aria-label={`Edit ${option.name}`}
          />
        }
      >
        <MoreHorizontalIcon />
      </PopoverTrigger>
      <PopoverPopup side="right" align="start" padding="compact">
        {confirming ? (
          <div className="w-56 space-y-2">
            <p className="text-sm">Delete “{option.name}”?</p>
            <p className="text-xs text-muted-foreground">Rows lose this option.</p>
            <div className="flex justify-end gap-1.5">
              <Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="xs"
                onClick={() =>
                  void actions.updateSchema([
                    { op: "removeOption", propertyId: known.id, optionId },
                  ])
                }
              >
                Delete
              </Button>
            </div>
          </div>
        ) : (
          <div className="w-56 space-y-2">
            <DraftInput
              size="compact"
              autoFocus
              aria-label="Option name"
              value={option.name}
              onCommit={(name) => {
                if (name.trim() !== "") update({ name: name.trim() });
              }}
            />
            <Button
              variant="ghost-destructive"
              size="xs"
              className="w-full justify-start"
              onClick={() => setConfirming(true)}
            >
              <Trash2Icon />
              Delete option
            </Button>
            <Separator />
            <span className="text-xs text-muted-foreground">Colors</span>
            <ColorSwatches value={option.color} onChange={(color) => update({ color })} />
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
