import { Link, Navigate } from "@tanstack/react-router";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { useEnvironmentQuery } from "../state/query";
import { spacesEnvironment, useSpacesAvailability } from "../state/spaces";
import { Button } from "../components/ui/button";
import { useMainAppThreadRef, useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { useRightPanelStore } from "../rightPanelStore";
import { SpacesUnavailable } from "./SpacesUnavailable";

export default function SpacePageSurface({
  target,
  fullPage = false,
}: {
  target: SpacePageNavigationTarget;
  fullPage?: boolean;
}) {
  const availability = useSpacesAvailability(target.environmentId);
  const query = useEnvironmentQuery(
    canBrowseSpaces(availability)
      ? spacesEnvironment.page({
          environmentId: target.environmentId,
          input: { environmentId: target.environmentId, pageId: target.pageId },
        })
      : null,
  );
  const threadRef = useMainAppThreadRef();
  const navigateToMainApp = useNavigateToMainApp();
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
  if (!query.data)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading page…
      </p>
    );
  const { page, space } = query.data;
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
        {fullPage && threadRef ? (
          <Button
            variant="outline"
            onClick={() => {
              useRightPanelStore.getState().openSpacePage(threadRef, resolvedTarget);
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
