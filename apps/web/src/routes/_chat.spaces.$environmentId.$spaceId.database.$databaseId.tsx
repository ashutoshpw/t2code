import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceDatabaseId, SpaceId, SpaceViewId } from "@t2code/contracts/spaces";
import { lazy, Suspense } from "react";

const DatabaseFullPage = lazy(() => import("../spaces/databases/page/DatabaseFullPage"));

export const Route = createFileRoute("/_chat/spaces/$environmentId/$spaceId/database/$databaseId")({
  validateSearch: (search: Record<string, unknown>): { viewId?: string } =>
    typeof search.viewId === "string" && search.viewId !== "" ? { viewId: search.viewId } : {},
  component: DatabaseFullPageRoute,
});

function DatabaseFullPageRoute() {
  const params = Route.useParams();
  const { viewId } = Route.useSearch();
  return (
    <Suspense fallback={null}>
      <DatabaseFullPage
        environmentId={EnvironmentId.make(params.environmentId)}
        spaceId={SpaceId.make(params.spaceId)}
        databaseId={SpaceDatabaseId.make(params.databaseId)}
        {...(viewId ? { viewId: SpaceViewId.make(viewId) } : {})}
      />
    </Suspense>
  );
}
