import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceId, SpacePageId } from "@t2code/contracts/spaces";
import { validateSpacePageSearch } from "@t2code/client-runtime/spaces";
import { lazy, Suspense } from "react";
const SpacePageSurface = lazy(() => import("../spaces/SpacePageSurface"));
export const Route = createFileRoute("/_chat/spaces/$environmentId/$spaceId/$pageId")({
  validateSearch: validateSpacePageSearch,
  component: SpacePageRoute,
});
function SpacePageRoute() {
  const params = Route.useParams();
  const { block } = Route.useSearch();
  return (
    <Suspense fallback={null}>
      <SpacePageSurface
        fullPage
        target={{
          environmentId: EnvironmentId.make(params.environmentId),
          spaceId: SpaceId.make(params.spaceId),
          pageId: SpacePageId.make(params.pageId),
          ...(block ? { blockId: block } : {}),
        }}
      />
    </Suspense>
  );
}
