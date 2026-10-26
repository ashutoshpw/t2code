import { useEffect } from "react";
import type { ScopedThreadRef } from "@t2code/contracts";
import { Link, Navigate } from "@tanstack/react-router";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironment } from "../state/environments";
import { spacesEnvironment, useSpacesAvailability } from "../state/spaces";
import { Button } from "../components/ui/button";
import { useMainAppThreadRef, useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { useRightPanelStore } from "../rightPanelStore";
import { SpacesUnavailable } from "./SpacesUnavailable";

export default function SpacePageSurface({
  target,
  fullPage = false,
  threadRef,
}: {
  target: SpacePageNavigationTarget;
  fullPage?: boolean;
  threadRef?: ScopedThreadRef;
}) {
  const availability = useSpacesAvailability(target.environmentId);
  const environment = useEnvironment(target.environmentId);
  const version = environment?.serverConfig?.environment.capabilities.spaces?.version;
  const query = useEnvironmentQuery(
    canBrowseSpaces(availability) && (version === 1 || version === 2)
      ? spacesEnvironment.location({
          environmentId: target.environmentId,
          input: { environmentId: target.environmentId, pageId: target.pageId, version },
        })
      : null,
  );
  const mainAppThreadRef = useMainAppThreadRef();
  const navigateToMainApp = useNavigateToMainApp();
  const currentSpaceId = query.isSuccess && !query.isPending ? query.data?.page.spaceId : undefined;
  // oxlint-disable-next-line t2code/react-effect-budget -- synchronize the authorized current location with the persisted panel hint.
  useEffect(() => {
    if (threadRef && currentSpaceId)
      useRightPanelStore.getState().updateSpacePageLocation(threadRef, {
        environmentId: target.environmentId,
        pageId: target.pageId,
        spaceId: currentSpaceId,
      });
  }, [threadRef, currentSpaceId, target.environmentId, target.pageId]);
  if (!canBrowseSpaces(availability)) return <SpacesUnavailable availability={availability} />;
  if (query.error)
    return (
      <div className="p-4">
        <p role="alert">{query.error}</p>
        <Button variant="outline" onClick={query.refresh}>
          Retry
        </Button>
      </div>
    );
  if (!query.data || query.isPending)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading page…
      </p>
    );
  const { page, space, ancestors } = query.data;
  const resolvedTarget = { ...target, spaceId: page.spaceId };
  if (fullPage && page.spaceId !== target.spaceId)
    return (
      <Navigate
        to="/spaces/$environmentId/$spaceId/$pageId"
        params={resolvedTarget}
        search={target.blockId ? { block: target.blockId } : {}}
        replace
      />
    );
  return (
    <section className="min-w-0 p-4" aria-label="Space page">
      <Link
        to="/spaces/$environmentId/$spaceId"
        params={{ environmentId: target.environmentId, spaceId: space.id }}
        className="text-sm text-muted-foreground underline"
      >
        {space.title}
      </Link>
      <nav aria-label="Page location" className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        {ancestors.map((ancestor) => (
          <Link
            key={ancestor.id}
            to="/spaces/$environmentId/$spaceId/$pageId"
            params={{
              environmentId: target.environmentId,
              spaceId: ancestor.spaceId,
              pageId: ancestor.id,
            }}
            search={{}}
            className="break-words underline"
          >
            {ancestor.title || "Untitled page"} /
          </Link>
        ))}
        <span aria-current="page">{page.title || "Untitled page"}</span>
      </nav>
      <div className="mt-2">
        <Button variant="ghost" size="sm" onClick={query.refresh}>
          Refresh location
        </Button>
      </div>
      <h1 className="mt-3 break-words text-xl font-semibold">{page.title || "Untitled page"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Revision {page.revision} · Updated {page.updatedAt}
      </p>
      <p className="mt-3 text-sm text-muted-foreground">This page is read-only.</p>
      {target.blockId ? (
        <p className="mt-2 break-words text-sm text-muted-foreground">
          Linked block: {target.blockId}
        </p>
      ) : null}
      <div className="mt-4 flex gap-2">
        {fullPage && mainAppThreadRef ? (
          <Button
            variant="outline"
            onClick={() => {
              useRightPanelStore.getState().openSpacePage(mainAppThreadRef, resolvedTarget);
              void navigateToMainApp();
            }}
          >
            Open beside chat
          </Button>
        ) : null}
        {!fullPage ? (
          <Link
            to="/spaces/$environmentId/$spaceId/$pageId"
            params={resolvedTarget}
            search={target.blockId ? { block: target.blockId } : {}}
            className="text-sm underline"
          >
            Open page
          </Link>
        ) : null}
      </div>
    </section>
  );
}
