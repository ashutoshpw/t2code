import { lazy, Suspense, useEffect, useState } from "react";
import type { ScopedThreadRef } from "@t2code/contracts";
import { Link, useRouter } from "@tanstack/react-router";
import {
  validateSpacePageSearch,
  type SpacePageNavigationTarget,
} from "@t2code/client-runtime/spaces";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironment } from "../state/environments";
import { spacesEnvironment, useSpacesAvailability } from "../state/spaces";
import { Button } from "../components/ui/button";
import { useMainAppThreadRef, useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { SpacesUnavailable } from "./SpacesUnavailable";
import { SpaceDocumentSurface } from "./SpaceDocumentSurface";

const SpaceStructureControls = lazy(() => import("./SpaceStructureControls"));

interface SpacePageSurfaceProps {
  target: SpacePageNavigationTarget;
  fullPage?: boolean;
  threadRef?: ScopedThreadRef;
}

export default function SpacePageSurface(props: SpacePageSurfaceProps) {
  const availability = useSpacesAvailability(props.target.environmentId);
  if (!canBrowseSpaces(availability)) return <SpacesUnavailable availability={availability} />;
  return (
    <section className="min-w-0 p-4" aria-label="Space page">
      <SpacePageMetadata {...props} />
      <SpaceDocumentSurface
        key={JSON.stringify([props.target.environmentId, props.target.pageId])}
        target={props.target}
      />
    </section>
  );
}

function SpacePageMetadata({ target, fullPage = false, threadRef }: SpacePageSurfaceProps) {
  const availability = useSpacesAvailability(target.environmentId);
  const environment = useEnvironment(target.environmentId);
  const version = environment?.serverConfig?.environment.capabilities.spaces?.version;
  const available = canBrowseSpaces(availability);
  const ownerKey = JSON.stringify([
    available,
    version,
    target.environmentId,
    target.pageId,
    target.spaceId,
    target.blockId,
    threadRef?.environmentId,
    threadRef?.threadId,
    fullPage,
  ]);
  const createQuery = () =>
    available && (version === 1 || version === 2)
      ? spacesEnvironment.location({
          environmentId: target.environmentId,
          input: { environmentId: target.environmentId, pageId: target.pageId, version },
        })
      : null;
  const [locationOwner, setLocationOwner] = useState(() => ({
    key: ownerKey,
    query: createQuery(),
  }));
  let owner = locationOwner;
  if (owner.key !== ownerKey) {
    owner = { key: ownerKey, query: createQuery() };
    setLocationOwner(owner);
  }
  const query = useEnvironmentQuery(owner.query);
  const router = useRouter();
  const mainAppThreadRef = useMainAppThreadRef();
  const navigateToMainApp = useNavigateToMainApp();
  // oxlint-disable-next-line t2code/react-effect-budget -- apply current location to the persisted panel hint and canonical route.
  useEffect(() => {
    const current = query.isSuccess && !query.isPending ? query.data?.current() : null;
    if (!current) return;
    if (threadRef) {
      const panel = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      ).surfaces.find(
        (surface) =>
          surface.kind === "space-page" &&
          surface.target.environmentId === target.environmentId &&
          surface.target.pageId === target.pageId,
      );
      if (panel?.kind === "space-page" && panel.target === target)
        useRightPanelStore.getState().updateSpacePageLocation(threadRef, {
          environmentId: target.environmentId,
          pageId: target.pageId,
          spaceId: current.page.spaceId,
        });
    }
    const params = router.state.matches.at(-1)?.params ?? {};
    const search = validateSpacePageSearch(router.state.location.search);
    if (
      fullPage &&
      "environmentId" in params &&
      params.environmentId === target.environmentId &&
      "spaceId" in params &&
      params.spaceId === target.spaceId &&
      "pageId" in params &&
      params.pageId === target.pageId &&
      search.block === target.blockId &&
      current.page.spaceId !== target.spaceId
    )
      void router.navigate({
        to: "/spaces/$environmentId/$spaceId/$pageId",
        params: { ...target, spaceId: current.page.spaceId },
        search: target.blockId ? { block: target.blockId } : {},
        replace: true,
      });
  }, [query.data, query.isSuccess, query.isPending, target, threadRef, fullPage, router]);
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
  const current = query.isSuccess && !query.isPending ? query.data?.current() : null;
  if (!current)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading page…
      </p>
    );
  const { page, space, ancestors } = current;
  const resolvedTarget = { ...target, spaceId: page.spaceId };
  return (
    <>
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
      {version === 2 ? (
        <Suspense fallback={<p role="status">Loading page placement…</p>}>
          <SpaceStructureControls
            key={JSON.stringify([target.environmentId, target.pageId])}
            target={resolvedTarget}
            location={page.location}
            current={() => {
              const live = query.isPending ? null : query.data?.current();
              return (
                live?.page.id === target.pageId &&
                live.page.spaceId === resolvedTarget.spaceId &&
                (live.page.location?.kind === "root" || live.page.location?.kind === "child")
              );
            }}
          />
        </Suspense>
      ) : null}
      <h1 className="mt-3 break-words text-xl font-semibold">{page.title || "Untitled page"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Revision {page.revision} · Updated {page.updatedAt}
      </p>
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
              const current = query.isPending ? null : query.data?.current();
              if (!current) return;
              useRightPanelStore
                .getState()
                .openSpacePage(mainAppThreadRef, { ...target, spaceId: current.page.spaceId });
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
    </>
  );
}
