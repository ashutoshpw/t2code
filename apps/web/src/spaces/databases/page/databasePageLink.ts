import { useRouter } from "@tanstack/react-router";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDatabaseId, SpaceId, SpaceViewId } from "@t2code/contracts/spaces";

interface DatabasePageTarget {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly databaseId: SpaceDatabaseId;
  readonly viewId?: SpaceViewId;
}

// The search key is not `view`: the parent spaces route already owns that one.
const ROUTE = "/spaces/$environmentId/$spaceId/database/$databaseId" as const;

/** Database surfaces render without a router in some hosts and tests: then open does nothing and href is null. */
export function useDatabasePageNavigation() {
  const router = useRouter({ warn: false });
  const options = ({ environmentId, spaceId, databaseId, viewId }: DatabasePageTarget) => ({
    to: ROUTE,
    params: { environmentId, spaceId, databaseId },
    search: viewId ? { viewId } : {},
  });
  return {
    open: (target: DatabasePageTarget) => {
      void router?.navigate(options(target));
    },
    href: (target: DatabasePageTarget) =>
      router === undefined
        ? null
        : new URL(router.buildLocation(options(target)).href, window.location.origin).toString(),
  };
}
