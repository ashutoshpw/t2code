import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceId } from "@t2code/contracts/spaces";
import { type SpaceNavigationWindow } from "@t2code/client-runtime/spaces";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { useEnvironment } from "../state/environments";
import { spacePageNavigation, useSpacesAvailability } from "../state/spaces";
import { Button } from "../components/ui/button";
import { useSidebar } from "../components/ui/sidebar";
import { SpacesUnavailable } from "./SpacesUnavailable";

export function SpacePageTree({
  environmentId,
  spaceId,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
}) {
  const availability = useSpacesAvailability(environmentId);
  const environment = useEnvironment(environmentId);
  const capability = environment?.serverConfig?.environment.capabilities.spaces;
  if (
    !canBrowseSpaces(availability) ||
    !capability ||
    (capability.version !== 1 && capability.version !== 2)
  )
    return <SpacesUnavailable availability={availability} />;
  return (
    <PageTree
      key={JSON.stringify([
        environmentId,
        spaceId,
        capability.version,
        capability.limits.maxListRows,
      ])}
      environmentId={environmentId}
      spaceId={spaceId}
      version={capability.version}
      maxRows={capability.limits.maxListRows}
    />
  );
}

function PageTree({
  environmentId,
  spaceId,
  version,
  maxRows,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
  version: 1 | 2;
  maxRows: number;
}) {
  const [navigation] = useState(() =>
    spacePageNavigation({ environmentId, spaceId, version, maxRows }),
  );
  const snapshot = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot);
  const { isMobile, setOpenMobile } = useSidebar();
  const windows = new Map(snapshot.windows.map((window) => [window.parentPageId, window]));
  const renderWindow = (window: SpaceNavigationWindow): ReactNode => (
    <div className="min-w-0 space-y-2">
      {window.error ? (
        <div>
          <p role="alert" className="text-sm">
            {window.error}
          </p>
          <Button variant="outline" onClick={() => navigation.first(window.parentPageId)}>
            Retry from first pages
          </Button>
        </div>
      ) : !window.data ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading pages…
        </p>
      ) : window.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {window.parentPageId === null ? "No pages in this space." : "No child pages."}
        </p>
      ) : (
        <ul className="space-y-2">
          {window.data.items.map((page) => {
            const children = windows.get(page.id);
            return (
              <li key={page.id} className="min-w-0">
                <div className="flex min-w-0 items-start gap-2">
                  {version === 2 ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`${children ? "Hide" : "Show"} child pages of ${page.title || "Untitled page"}`}
                      aria-expanded={children !== undefined}
                      disabled={window.pending && !children}
                      onClick={() => navigation.expand(window.parentPageId, page.id)}
                    >
                      {children ? "−" : "+"}
                    </Button>
                  ) : null}
                  <Link
                    to="/spaces/$environmentId/$spaceId/$pageId"
                    params={{ environmentId, spaceId: page.spaceId, pageId: page.id }}
                    search={{}}
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                    className="min-w-0 break-words text-sm underline"
                  >
                    {page.title || "Untitled page"}
                  </Link>
                </div>
                {children ? (
                  <div className="mt-2 border-l pl-3">{renderWindow(children)}</div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {window.cursor ? (
          <Button
            variant="outline"
            disabled={window.pending}
            onClick={() => navigation.first(window.parentPageId)}
          >
            First pages
          </Button>
        ) : null}
        {window.data?.nextCursor && !window.error ? (
          <Button
            variant="outline"
            disabled={window.pending}
            onClick={() => navigation.next(window.parentPageId)}
          >
            Next pages
          </Button>
        ) : null}
      </div>
    </div>
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 break-words text-sm font-semibold">
          {windows.get(null)?.data?.space.title ?? "Pages"}
        </h2>
        <Button variant="ghost" size="sm" onClick={navigation.refresh}>
          Refresh pages
        </Button>
      </div>
      {snapshot.error ? (
        <p role="alert" className="text-sm">
          {snapshot.error}
        </p>
      ) : null}
      {windows.get(null) ? (
        renderWindow(windows.get(null)!)
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Loading pages…
        </p>
      )}
    </div>
  );
}
