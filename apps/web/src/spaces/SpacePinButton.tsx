import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useState } from "react";
import { StarIcon } from "lucide-react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageSummary } from "@t2code/contracts/spaces";
import { useEnvironment } from "../state/environments";
import { spacesEnvironment } from "../state/spaces";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { toastManager } from "../components/ui/toast";

export function SpacePinButton({
  environmentId,
  page,
}: {
  environmentId: EnvironmentId;
  page: SpacePageSummary;
}) {
  const registry = useContext(RegistryContext);
  const capability = useEnvironment(environmentId)?.serverConfig?.environment.capabilities.spaces;
  const canAdd = useAtomValue(spacesEnvironment.addPin.permissionAtom(environmentId));
  const canRemove = useAtomValue(spacesEnvironment.removePin.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  if (!capability?.features?.pins) return null;
  const pinned = page.isPinned === true;
  const command = pinned ? spacesEnvironment.removePin : spacesEnvironment.addPin;
  const label = pinned ? "Unpin page" : "Pin page";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-pressed={pinned}
            disabled={pending || !(pinned ? canRemove : canAdd)}
            onClick={() => {
              setPending(true);
              void command
                .run(registry, { environmentId, input: { environmentId, pageId: page.id } })
                .then((result) => {
                  if (result._tag === "Success") {
                    registry.update(spacesEnvironment.changed(environmentId), (v) => v + 1);
                    registry.update(spacesEnvironment.libraryChanged(environmentId), (v) => v + 1);
                  } else toastManager.add({ type: "error", title: "Couldn't update pin" });
                  setPending(false);
                });
            }}
          />
        }
      >
        <StarIcon className={pinned ? "fill-current" : undefined} />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
