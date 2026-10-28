import { Fragment, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { ArrowUpRightIcon, ChevronRightIcon, PanelRightIcon, RefreshCwIcon } from "lucide-react";
import type { EnvironmentId, ScopedThreadRef } from "@t2code/contracts";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useRelativeTimeState } from "../hooks/useRelativeTimeState";
import { useMainAppThreadRef, useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { SpacesUnavailable } from "./SpacesUnavailable";
import { SpaceDocumentSurface } from "./SpaceDocumentSurface";

const SpaceLibraryControls = lazy(() => import("./SpaceLibraryControls"));
const SpaceRecoveryControls = lazy(() => import("./SpaceRecoveryControls"));
const SpaceStructureControls = lazy(() => import("./SpaceStructureControls"));

interface SpacePageSurfaceProps {
  target: SpacePageNavigationTarget;
  fullPage?: boolean;
  threadRef?: ScopedThreadRef;
}

export default function SpacePageSurface(props: SpacePageSurfaceProps) {
  const availability = useSpacesAvailability(props.target.environmentId);
  const router = useRouter();
  const current = () => {
    if (!canBrowseSpaces(availability)) return false;
    if (props.threadRef) {
      const panel = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        props.threadRef,
      ).surfaces.find(
        (surface) =>
          surface.kind === "space-page" &&
          surface.target.environmentId === props.target.environmentId &&
          surface.target.pageId === props.target.pageId,
      );
      return panel?.kind === "space-page" && panel.target === props.target;
    }
    const params = router.state.matches.at(-1)?.params ?? {};
    return (
      !!props.fullPage &&
      "environmentId" in params &&
      params.environmentId === props.target.environmentId &&
      "pageId" in params &&
      params.pageId === props.target.pageId &&
      "spaceId" in params &&
      params.spaceId === props.target.spaceId &&
      validateSpacePageSearch(router.state.location.search).block === props.target.blockId
    );
  };
  const openSource = (target: SpacePageNavigationTarget) => {
    if (!current() || target.environmentId !== props.target.environmentId) return;
    if (props.threadRef) useRightPanelStore.getState().openSpacePage(props.threadRef, target);
    else
      void router.navigate({
        to: "/spaces/$environmentId/$spaceId/$pageId",
        params: target,
        search: target.blockId ? { block: target.blockId } : {},
      });
  };
  if (!canBrowseSpaces(availability)) return <SpacesUnavailable availability={availability} />;
  return (
    <section
      aria-label="Space page"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <SpacePageMetadata {...props}>
        <SpaceDocumentSurface
          key={JSON.stringify([props.target.environmentId, props.target.pageId])}
          target={props.target}
          current={current}
          onOpenSource={openSource}
        />
      </SpacePageMetadata>
    </section>
  );
}

function PageBar({
  fullPage,
  environmentId,
  breadcrumb,
  children,
}: {
  fullPage: boolean;
  environmentId: EnvironmentId;
  breadcrumb?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header
      className={cn(
        "z-10 flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b bg-background px-4 py-1",
        fullPage && "sticky top-0",
      )}
    >
      <div className="min-w-0 flex-1">{breadcrumb}</div>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {children}
        <Suspense
          fallback={
            <p role="status" className="text-xs text-muted-foreground">
              Loading recovery…
            </p>
          }
        >
          <SpaceRecoveryControls key={environmentId} environmentId={environmentId} />
        </Suspense>
      </div>
    </header>
  );
}

function PageColumn({ fullPage, children }: { fullPage: boolean; children: ReactNode }) {
  return (
    <div
      className={cn("mx-auto w-full min-w-0 max-w-3xl px-4", fullPage ? "py-10 sm:px-6" : "py-6")}
    >
      {children}
    </div>
  );
}

function EditedMeta({ updatedAt, revision }: { updatedAt: string; revision: number }) {
  const relative = useRelativeTimeState(updatedAt);
  return (
    <Tooltip>
      <TooltipTrigger render={<p className="mt-2 w-fit text-sm text-muted-foreground" />}>
        Edited{" "}
        {relative.status === "relative"
          ? relative.suffix
            ? `${relative.value} ${relative.suffix}`
            : relative.value
          : updatedAt}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{`Revision ${revision} · ${updatedAt}`}</TooltipPopup>
    </Tooltip>
  );
}

function SpacePageMetadata({
  target,
  fullPage = false,
  threadRef,
  children,
}: SpacePageSurfaceProps & { children: ReactNode }) {
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
      <>
        <PageBar fullPage={fullPage} environmentId={target.environmentId} />
        <PageColumn fullPage={fullPage}>
          <p role="alert">{query.error}</p>
          <Button variant="outline" size="sm" onClick={query.refresh}>
            Retry
          </Button>
          {children}
        </PageColumn>
      </>
    );
  const current = query.isSuccess && !query.isPending ? query.data?.current() : null;
  if (!current)
    return (
      <>
        <PageBar fullPage={fullPage} environmentId={target.environmentId} />
        <PageColumn fullPage={fullPage}>
          <p role="status" className="text-sm text-muted-foreground">
            Loading page…
          </p>
          {children}
        </PageColumn>
      </>
    );
  const { page, space, ancestors } = current;
  const resolvedTarget = { ...target, spaceId: page.spaceId };
  const crumb = "truncate rounded-sm hover:text-foreground";
  return (
    <>
      <PageBar
        fullPage={fullPage}
        environmentId={target.environmentId}
        breadcrumb={
          <nav
            aria-label="Page location"
            className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground"
          >
            <Link
              to="/spaces/$environmentId/$spaceId"
              params={{ environmentId: target.environmentId, spaceId: space.id }}
              className={cn(crumb, "max-w-40 shrink-0")}
            >
              {space.title}
            </Link>
            {ancestors.map((ancestor) => (
              <Fragment key={ancestor.id}>
                <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden />
                <Link
                  to="/spaces/$environmentId/$spaceId/$pageId"
                  params={{
                    environmentId: target.environmentId,
                    spaceId: ancestor.spaceId,
                    pageId: ancestor.id,
                  }}
                  search={{}}
                  className={cn(crumb, "max-w-40 shrink-0")}
                >
                  {ancestor.title || "Untitled page"}
                </Link>
              </Fragment>
            ))}
            <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden />
            <span aria-current="page" className="truncate text-foreground">
              {page.title || "Untitled page"}
            </span>
          </nav>
        }
      >
        {fullPage && mainAppThreadRef ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const current = query.isPending ? null : query.data?.current();
              if (!current) return;
              useRightPanelStore
                .getState()
                .openSpacePage(mainAppThreadRef, { ...target, spaceId: current.page.spaceId });
              void navigateToMainApp();
            }}
          >
            <PanelRightIcon />
            Open beside chat
          </Button>
        ) : null}
        {!fullPage ? (
          <Button
            variant="ghost"
            size="sm"
            render={
              <Link
                to="/spaces/$environmentId/$spaceId/$pageId"
                params={resolvedTarget}
                search={target.blockId ? { block: target.blockId } : {}}
              />
            }
          >
            <ArrowUpRightIcon />
            Open page
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh location"
                onClick={query.refresh}
              />
            }
          >
            <RefreshCwIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Refresh location</TooltipPopup>
        </Tooltip>
        <Suspense
          fallback={
            <p role="status" className="text-xs text-muted-foreground">
              Loading page controls…
            </p>
          }
        >
          <SpaceLibraryControls
            key={JSON.stringify([target.environmentId, target.pageId])}
            environmentId={target.environmentId}
            spaceId={page.spaceId}
            page={page}
            current={() => {
              const live = query.isPending ? null : query.data?.current();
              return (
                live?.page.id === target.pageId && live.page.spaceId === resolvedTarget.spaceId
              );
            }}
          />
        </Suspense>
        {version === 2 ? (
          <Suspense
            fallback={
              <p role="status" className="text-xs text-muted-foreground">
                Loading page placement…
              </p>
            }
          >
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
      </PageBar>
      <PageColumn fullPage={fullPage}>
        <h1 className="break-words text-4xl font-bold">{page.title || "Untitled page"}</h1>
        <EditedMeta updatedAt={page.updatedAt} revision={page.revision} />
        {target.blockId ? (
          <p className="mt-1 break-words text-sm text-muted-foreground">
            Linked block: {target.blockId}
          </p>
        ) : null}
        <div className="mt-8">{children}</div>
      </PageColumn>
    </>
  );
}
