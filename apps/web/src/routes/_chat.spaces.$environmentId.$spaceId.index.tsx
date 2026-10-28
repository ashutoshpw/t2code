import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceId } from "@t2code/contracts/spaces";
import { SpacesLibrary } from "../spaces/SpacesLibrary";
export const Route = createFileRoute("/_chat/spaces/$environmentId/$spaceId/")({
  component: SpaceLibraryRoute,
});
function SpaceLibraryRoute() {
  const params = Route.useParams();
  return (
    <SpacesLibrary
      key={`${params.environmentId}:${params.spaceId}`}
      environmentId={EnvironmentId.make(params.environmentId)}
      spaceId={SpaceId.make(params.spaceId)}
    />
  );
}
