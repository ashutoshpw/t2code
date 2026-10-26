import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceId, type SpaceCursor } from "@t2code/contracts/spaces";
import { useEnvironmentQuery } from "../state/query";
import { spacesEnvironment, useSpacesEnvironments } from "../state/spaces";
import { usePrimaryEnvironmentId } from "../state/environments";
import { SidebarContent, SidebarHeader, useSidebar } from "../components/ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "../components/sidebar/SidebarChrome";
import { Button } from "../components/ui/button";
import { SpacePageTree } from "./SpacePageTree";
import { isElectron } from "../env";

export function SpacesSidebar() {
  const params = useParams({ strict: false });
  const environments = useSpacesEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const environment = params.environmentId
    ? environments.find((entry) => entry.environmentId === params.environmentId)
    : (environments.find((entry) => entry.environmentId === primaryId) ?? environments[0]);
  return (
    <>
      <SidebarHeader>
        <SidebarChromeHeader isElectron={isElectron} />
      </SidebarHeader>
      <SidebarContent>
        <div className="space-y-3 p-3">
          <h2 className="text-sm font-semibold">Spaces</h2>
          {environments.map((entry) => (
            <div key={entry.environmentId}>
              <Link
                to="/spaces"
                search={{ environmentId: entry.environmentId }}
                className="text-sm underline"
              >
                {entry.label}
              </Link>
            </div>
          ))}
          {environment ? (
            <SpaceWindows
              key={environment.environmentId}
              environmentId={environment.environmentId}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No available environments.</p>
          )}
          {environment && params.spaceId ? (
            <SpacePageTree
              key={JSON.stringify([environment.environmentId, params.spaceId])}
              environmentId={environment.environmentId}
              spaceId={SpaceId.make(params.spaceId)}
            />
          ) : null}
        </div>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function SpaceWindows({ environmentId }: { environmentId: EnvironmentId }) {
  const [cursor, setCursor] = useState<SpaceCursor>();
  const { isMobile, setOpenMobile } = useSidebar();
  const query = useEnvironmentQuery(
    spacesEnvironment.list({
      environmentId,
      input: { environmentId, limit: 1, ...(cursor ? { cursor } : {}) },
    }),
  );
  return (
    <div className="space-y-2">
      {query.error ? (
        <>
          <p role="alert">{query.error}</p>
          <Button
            variant="outline"
            onClick={() => {
              setCursor(undefined);
              query.refresh();
            }}
          >
            Retry
          </Button>
        </>
      ) : !query.data ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading spaces…
        </p>
      ) : (
        query.data.items.map((space) => (
          <div key={space.id}>
            <Link
              to="/spaces/$environmentId/$spaceId"
              params={{ environmentId, spaceId: space.id }}
              search={{}}
              onClick={() => {
                if (isMobile) setOpenMobile(false);
              }}
              className="break-words text-sm underline"
            >
              {space.title}
            </Link>
          </div>
        ))
      )}
      {cursor ? (
        <Button variant="outline" onClick={() => setCursor(undefined)}>
          First spaces
        </Button>
      ) : null}
      {query.data?.nextCursor && !query.error ? (
        <Button
          variant="outline"
          disabled={query.isPending}
          onClick={() => setCursor(query.data!.nextCursor!)}
        >
          Next spaces
        </Button>
      ) : null}
    </div>
  );
}
