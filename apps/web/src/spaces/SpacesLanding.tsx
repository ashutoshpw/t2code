import { Navigate, useSearch } from "@tanstack/react-router";
import { useEnvironmentQuery } from "../state/query";
import { spacesEnvironment, useSpacesEnvironments } from "../state/spaces";
import { usePrimaryEnvironmentId } from "../state/environments";
import { Button } from "../components/ui/button";
import { SpacesUnavailable } from "./SpacesUnavailable";

export function SpacesLanding() {
  const { environmentId: selectedId } = useSearch({ from: "/_chat/spaces" });
  const environments = useSpacesEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const environment = selectedId
    ? environments.find((entry) => entry.environmentId === selectedId)
    : (environments.find((entry) => entry.environmentId === primaryId) ?? environments[0]);
  const environmentId = environment?.environmentId;
  const query = useEnvironmentQuery(
    environmentId
      ? spacesEnvironment.list({ environmentId, input: { environmentId, limit: 1 } })
      : null,
  );
  if (!environmentId) return <SpacesUnavailable availability="unavailable" />;
  if (query.error)
    return (
      <div className="p-4">
        <p role="alert">{query.error}</p>
        <Button variant="outline" onClick={query.refresh}>
          Retry
        </Button>
      </div>
    );
  if (!query.data)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading Spaces…
      </p>
    );
  return (
    <Navigate
      to="/spaces/$environmentId/$spaceId"
      params={{ environmentId, spaceId: query.data.defaultSpaceId }}
      search={{}}
      replace
    />
  );
}
