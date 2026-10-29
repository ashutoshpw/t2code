import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageId } from "@t2code/contracts/spaces";
import { Share2Icon } from "lucide-react";
import { useContext, useEffect } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useEnvironment } from "~/state/environments";
import { spacesEnvironment } from "~/state/spaces";
import { Button } from "../components/ui/button";
import { openSpacePageShareDialog } from "./spacePageShareDialogState";

/** Header button for a page that is the root of a share. Sub-pages of a shared page show nothing. */
export function SpacePageShareStatus({
  environmentId,
  pageId,
}: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
}) {
  const registry = useContext(RegistryContext);
  const enabled =
    useEnvironment(environmentId)?.serverConfig?.settings.spacesPageSharingEnabled === true;
  const canRead = useAtomValue(spacesEnvironment.getPageShare.permissionAtom(environmentId));
  const link = useAtomValue(spacesEnvironment.pageShare(environmentId, pageId));
  const nowMinute = useNowMinute();
  // oxlint-disable-next-line t2code/react-effect-budget -- Reads the page's share from the environment when the page opens.
  useEffect(() => {
    if (!enabled || !canRead) return;
    void spacesEnvironment.getPageShare.run(registry, { environmentId, input: { pageId } });
  }, [registry, enabled, canRead, environmentId, pageId]);
  if (!enabled || !link || link.share.expiresAt.slice(0, 16) <= nowMinute) return null;
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={() => openSpacePageShareDialog({ environmentId, pageId })}
    >
      <Share2Icon />
      Shared
    </Button>
  );
}
