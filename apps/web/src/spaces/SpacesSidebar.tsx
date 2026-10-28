import { lazy, Suspense, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceId, type SpaceCursor } from "@t2code/contracts/spaces";
import { useEnvironmentQuery } from "../state/query";
import { spacesEnvironment, useSpacesEnvironments } from "../state/spaces";
import { usePrimaryEnvironmentId } from "../state/environments";
import { LibraryIcon, ServerIcon } from "lucide-react";
import { useEnvironment } from "../state/environments";
import {
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../components/ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "../components/sidebar/SidebarChrome";
import { Button } from "../components/ui/button";
import { SpacePageTree } from "./SpacePageTree";
import { isElectron } from "../env";

const CreateControls = lazy(() =>
  import("./SpaceCreateControls").then((module) => ({
    default: module.SidebarCreateControls,
  })),
);
const NewSpaceButton = lazy(() =>
  import("./SpaceCreateControls").then((module) => ({ default: module.NewSpaceButton })),
);

export function SpacesSidebar() {
  const params = useParams({ strict: false });
  const environments = useSpacesEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const environment = params.environmentId
    ? environments.find((entry) => entry.environmentId === params.environmentId)
    : (environments.find((entry) => entry.environmentId === primaryId) ?? environments[0]);
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  return (
    <>
      <SidebarHeader>
        <SidebarChromeHeader isElectron={isElectron} />
      </SidebarHeader>
      {environment ? (
        <div className="space-y-2 px-2 pt-2">
          <Suspense fallback={null}>
            <CreateControls
              key={environment.environmentId}
              environmentId={environment.environmentId}
              spaceId={params.spaceId ? SpaceId.make(params.spaceId) : undefined}
              onNavigate={closeMobile}
            />
          </Suspense>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="max-h-1/2 min-h-0 shrink-0 overflow-y-auto px-2 py-2">
          <div className="flex items-center justify-between pb-1 pl-2">
            <h2 className="text-xs font-medium text-sidebar-muted-foreground">Spaces</h2>
            {environment ? (
              <Suspense fallback={null}>
                <NewSpaceButton
                  key={environment.environmentId}
                  environmentId={environment.environmentId}
                  onNavigate={closeMobile}
                />
              </Suspense>
            ) : null}
          </div>
          {environments.length > 1 ? (
            <SidebarMenu className="mb-2">
              {environments.map((entry) => (
                <SidebarMenuItem key={entry.environmentId}>
                  <SidebarMenuButton
                    isActive={entry.environmentId === environment?.environmentId}
                    render={<Link to="/spaces" search={{ environmentId: entry.environmentId }} />}
                  >
                    <ServerIcon />
                    <span>{entry.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          ) : null}
          {environment ? (
            <SpaceWindows
              key={environment.environmentId}
              environmentId={environment.environmentId}
            />
          ) : (
            <p className="px-2 text-sm text-muted-foreground">No available environments.</p>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
          {environment && params.spaceId ? (
            <SpacePageTree
              key={JSON.stringify([environment.environmentId, params.spaceId])}
              environmentId={environment.environmentId}
              spaceId={SpaceId.make(params.spaceId)}
            />
          ) : null}
        </div>
      </div>
      <SidebarChromeFooter />
    </>
  );
}

function SpaceWindows({ environmentId }: { environmentId: EnvironmentId }) {
  const [cursor, setCursor] = useState<SpaceCursor>();
  const { isMobile, setOpenMobile } = useSidebar();
  const params = useParams({ strict: false });
  const environment = useEnvironment(environmentId);
  const limit =
    environment?.serverConfig?.environment.capabilities.spaces?.limits.maxListRows ?? 50;
  const query = useEnvironmentQuery(
    spacesEnvironment.list({
      environmentId,
      input: { environmentId, limit, ...(cursor ? { cursor } : {}) },
    }),
  );
  return (
    <div className="space-y-1">
      {query.error ? (
        <div className="px-2">
          <p role="alert" className="text-sm">
            {query.error}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setCursor(undefined);
              query.refresh();
            }}
          >
            Retry
          </Button>
        </div>
      ) : !query.data ? (
        <p role="status" className="px-2 text-sm text-muted-foreground">
          Loading spaces…
        </p>
      ) : (
        <SidebarMenu>
          {query.data.items.map((space) => (
            <SidebarMenuItem key={space.id}>
              <SidebarMenuButton
                isActive={space.id === params.spaceId}
                render={
                  <Link
                    to="/spaces/$environmentId/$spaceId"
                    params={{ environmentId, spaceId: space.id }}
                    search={{}}
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  />
                }
              >
                <LibraryIcon />
                <span>{space.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      )}
      {cursor || (query.data?.nextCursor && !query.error) ? (
        <div className="flex gap-1 px-1">
          {cursor ? (
            <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
              First spaces
            </Button>
          ) : null}
          {query.data?.nextCursor && !query.error ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={query.isPending}
              onClick={() => setCursor(query.data!.nextCursor!)}
            >
              Next spaces
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
