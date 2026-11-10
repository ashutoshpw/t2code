import { useAtomMount, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageId } from "@t2code/contracts/spaces";
import { Share2Icon } from "lucide-react";
import { Atom } from "effect/reactivity";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useEnvironment } from "~/state/environments";
import { spacesEnvironment } from "~/state/spaces";
import { Button } from "../components/ui/button";
import { openSpacePageShareDialog } from "./spacePageShareDialogState";

const pageShareRead = Atom.family(
  (target: { readonly environmentId: EnvironmentId; readonly pageId: SpacePageId }) =>
    Atom.make((get) => {
      void spacesEnvironment.getPageShare.run(get.registry, {
        environmentId: target.environmentId,
        input: { pageId: target.pageId },
      });
    }),
);
const pageShareReadIdle = Atom.make<void>(undefined);

/** Header button for a page that is the root of a share. Sub-pages of a shared page show nothing. */
export function SpacePageShareStatus({
  environmentId,
  pageId,
}: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
}) {
  const enabled =
    useEnvironment(environmentId)?.serverConfig?.settings.spacesPageSharingEnabled === true;
  const canRead = useAtomValue(spacesEnvironment.getPageShare.permissionAtom(environmentId));
  const link = useAtomValue(spacesEnvironment.pageShare(environmentId, pageId));
  const nowMinute = useNowMinute();
  useAtomMount(enabled && canRead ? pageShareRead({ environmentId, pageId }) : pageShareReadIdle);
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
