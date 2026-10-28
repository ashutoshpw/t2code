import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useState } from "react";
import { PinIcon, PinOffIcon } from "lucide-react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageSummary } from "@t2code/contracts/spaces";
import { useEnvironment } from "../state/environments";
import { spacesEnvironment } from "../state/spaces";
import { Button } from "../components/ui/button";

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
  const [error, setError] = useState(false);
  if (!capability?.features?.pins) return null;
  const pinned = page.isPinned === true;
  const command = pinned ? spacesEnvironment.removePin : spacesEnvironment.addPin;
  return (
    <span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={pinned ? "Unpin page" : "Pin page"}
        disabled={pending || !(pinned ? canRemove : canAdd)}
        onClick={() => {
          setPending(true);
          setError(false);
          void command
            .run(registry, { environmentId, input: { environmentId, pageId: page.id } })
            .then((result) => {
              if (result._tag === "Success") {
                registry.update(spacesEnvironment.changed(environmentId), (v) => v + 1);
                registry.update(spacesEnvironment.libraryChanged(environmentId), (v) => v + 1);
              } else setError(true);
              setPending(false);
            });
        }}
      >
        {pinned ? <PinOffIcon /> : <PinIcon />}
      </Button>
      {error ? <span role="alert">Unable to update pin.</span> : null}
    </span>
  );
}
