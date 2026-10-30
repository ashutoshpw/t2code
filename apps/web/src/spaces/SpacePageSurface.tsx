import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  Fragment,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FilePlusIcon,
  FolderInputIcon,
  LinkIcon,
  PanelRightIcon,
  Share2Icon,
  Trash2Icon,
} from "lucide-react";
import type { ScopedThreadRef } from "@t2code/contracts";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { toastManager } from "../components/ui/toast";
import { cn } from "../lib/utils";
import { useRelativeTimeState } from "../hooks/useRelativeTimeState";
import { useMainAppThreadRef, useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { SpacePinButton } from "./SpacePinButton";
import { SpacePageShareStatus } from "./SpacePageShareStatus";
import { openSpacePageShareDialog } from "./spacePageShareDialogState";
import { SpacesUnavailable } from "./SpacesUnavailable";
import { SpaceDocumentSurface } from "./SpaceDocumentSurface";
import type { SpaceRecoveryHandle } from "./SpaceRecoveryControls";
import type { SpaceStructureHandle } from "./SpaceStructureControls";

const PageTitleField = lazy(() =>
  import("./SpaceLibraryControls").then((module) => ({ default: module.PageTitleField })),
);
const PageIconField = lazy(() =>
  import("./SpaceLibraryControls").then((module) => ({ default: module.PageIconField })),
);
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
  breadcrumb,
  children,
}: {
  fullPage: boolean;
  breadcrumb?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header
      className={cn(
        "z-10 flex h-12 shrink-0 items-center justify-between gap-2 border-b bg-background px-4 max-md:pl-24",
        fullPage && "sticky top-0",
      )}
    >
      <div className="min-w-0 flex-1">{breadcrumb}</div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
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

function EditedMeta({ updatedAt }: { updatedAt: string }) {
  const relative = useRelativeTimeState(updatedAt);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="text-xs text-muted-foreground max-sm:hidden" />}>
        Edited{" "}
        {relative.status === "relative"
          ? relative.suffix
            ? `${relative.value} ${relative.suffix}`
            : relative.value
          : updatedAt}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{new Date(updatedAt).toLocaleString()}</TooltipPopup>
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
  const locationState = useRouterState({ select: (state) => state.location.state });
  const structure = useRef<SpaceStructureHandle>(null);
  const recovery = useRef<SpaceRecoveryHandle>(null);
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
  const registry = useContext(RegistryContext);
  const canRecord = useAtomValue(
    spacesEnvironment.recordRecent.permissionAtom(target.environmentId),
  );
  const recentEnabled =
    environment?.serverConfig?.environment.capabilities.spaces?.features?.recents === true;
  const pageReady = query.isSuccess && !query.isPending && !!query.data?.current();
  const recordedPage = useRef<string | null>(null);
  // oxlint-disable-next-line t2code/react-effect-budget -- Record a successfully opened page in the environment's shared recents.
  useEffect(() => {
    const key = JSON.stringify([target.environmentId, target.pageId]);
    if (!recentEnabled || !canRecord || !pageReady || recordedPage.current === key) return;
    recordedPage.current = key;
    void spacesEnvironment.recordRecent
      .run(registry, {
        environmentId: target.environmentId,
        input: { environmentId: target.environmentId, pageId: target.pageId },
      })
      .then((result) => {
        if (result._tag === "Success")
          registry.update(
            spacesEnvironment.libraryChanged(target.environmentId),
            (value) => value + 1,
          );
      });
  }, [registry, target.environmentId, target.pageId, recentEnabled, canRecord, pageReady]);
  if (!canBrowseSpaces(availability)) return <SpacesUnavailable availability={availability} />;
  if (query.error)
    return (
      <>
        <PageBar fullPage={fullPage} />
        <PageColumn fullPage={fullPage}>
          <p role="alert">{query.error}</p>
          <Button variant="outline" size="sm" onClick={query.refresh}>
            Retry
          </Button>
          {children}
        </PageColumn>
      </>
    );
  const current = query.isSuccess ? query.data?.current() : null;
  if (!current)
    return (
      <>
        <PageBar fullPage={fullPage} />
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
  const focusTitle = locationState.focusTitle === page.id && page.title === "";
  return (
    <>
      <PageBar
        fullPage={fullPage}
        breadcrumb={
          <nav
            aria-label="Page location"
            className="flex min-w-0 items-center gap-1 overflow-hidden text-sm text-muted-foreground"
          >
            <Link
              to="/spaces/$environmentId/$spaceId"
              params={{ environmentId: target.environmentId, spaceId: space.id }}
              className={cn(crumb, "max-w-40 max-sm:hidden")}
            >
              {space.title}
            </Link>
            {ancestors.map((ancestor) => (
              <Fragment key={ancestor.id}>
                <ChevronRightIcon className="size-3.5 shrink-0 max-sm:hidden" aria-hidden />
                <Link
                  to="/spaces/$environmentId/$spaceId/$pageId"
                  params={{
                    environmentId: target.environmentId,
                    spaceId: ancestor.spaceId,
                    pageId: ancestor.id,
                  }}
                  search={{}}
                  className={cn(crumb, "max-w-40 max-sm:hidden")}
                >
                  {ancestor.icon ? `${ancestor.icon} ` : ""}
                  {ancestor.title || "Untitled page"}
                </Link>
              </Fragment>
            ))}
            <ChevronRightIcon className="size-3.5 shrink-0 max-sm:hidden" aria-hidden />
            <span aria-current="page" className="truncate text-foreground">
              {page.icon ? `${page.icon} ` : ""}
              {page.title || "Untitled page"}
            </span>
          </nav>
        }
      >
        <EditedMeta updatedAt={page.updatedAt} />
        <SpacePageShareStatus environmentId={target.environmentId} pageId={page.id} />
        <SpacePinButton environmentId={target.environmentId} page={page} />
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}
                />
              }
            >
              <EllipsisIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">More actions</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            {version === 2 ? (
              <>
                <MenuItem onClick={() => structure.current?.openMove()}>
                  <FolderInputIcon />
                  Move to…
                </MenuItem>
                <MenuItem onClick={() => structure.current?.openChild()}>
                  <FilePlusIcon />
                  Add sub-page
                </MenuItem>
              </>
            ) : null}
            <MenuItem
              onClick={() => {
                const href = router.buildLocation({
                  to: "/spaces/$environmentId/$spaceId/$pageId",
                  params: resolvedTarget,
                  search: target.blockId ? { block: target.blockId } : {},
                }).href;
                void navigator.clipboard
                  .writeText(new URL(href, window.location.origin).toString())
                  .then(
                    () => toastManager.add({ type: "success", title: "Link copied" }),
                    () => toastManager.add({ type: "error", title: "Couldn't copy link" }),
                  );
              }}
            >
              <LinkIcon />
              Copy link
            </MenuItem>
            <MenuItem
              onClick={() =>
                openSpacePageShareDialog({ environmentId: target.environmentId, pageId: page.id })
              }
            >
              <Share2Icon />
              Share…
            </MenuItem>
            {fullPage && mainAppThreadRef ? (
              <MenuItem
                onClick={() => {
                  const live = query.isPending ? null : query.data?.current();
                  if (!live) return;
                  useRightPanelStore
                    .getState()
                    .openSpacePage(mainAppThreadRef, { ...target, spaceId: live.page.spaceId });
                  void navigateToMainApp();
                }}
              >
                <PanelRightIcon />
                Open beside chat
              </MenuItem>
            ) : null}
            {!fullPage ? (
              <MenuItem
                render={
                  <Link
                    to="/spaces/$environmentId/$spaceId/$pageId"
                    params={resolvedTarget}
                    search={target.blockId ? { block: target.blockId } : {}}
                  />
                }
              >
                <ArrowUpRightIcon />
                Open as full page
              </MenuItem>
            ) : null}
            {version === 2 ? (
              <>
                <MenuItem onClick={() => recovery.current?.trash()}>
                  <Trash2Icon />
                  Move to trash
                </MenuItem>
                <MenuSeparator />
                <MenuItem onClick={() => recovery.current?.openTrash()}>View trash</MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      </PageBar>
      <PageColumn fullPage={fullPage}>
        {version === 2 ? (
          <Suspense fallback={null}>
            <SpaceStructureControls
              ref={structure}
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
            <SpaceRecoveryControls
              ref={recovery}
              key={target.environmentId}
              environmentId={target.environmentId}
              pageId={target.pageId}
              spaceId={resolvedTarget.spaceId}
              parentPageId={page.location?.kind === "child" ? page.location.parentPageId : null}
              current={() => {
                const live = query.isPending ? null : query.data?.current();
                return (
                  live?.page.id === target.pageId && live.page.spaceId === resolvedTarget.spaceId
                );
              }}
            />
          </Suspense>
        ) : null}
        <div className="group/icon">
          <Suspense
            fallback={page.icon ? <span className="block text-6xl">{page.icon}</span> : null}
          >
            <PageIconField
              environmentId={target.environmentId}
              page={page}
              current={() => {
                const live = query.isPending ? null : query.data?.current();
                return (
                  live?.page.id === target.pageId && live.page.spaceId === resolvedTarget.spaceId
                );
              }}
            />
          </Suspense>
          <h1>
            <Suspense
              fallback={
                <span className="block text-4xl font-bold">{page.title || "Untitled"}</span>
              }
            >
              <PageTitleField
                environmentId={target.environmentId}
                page={page}
                autoFocus={focusTitle}
                current={() => {
                  const live = query.isPending ? null : query.data?.current();
                  return (
                    live?.page.id === target.pageId && live.page.spaceId === resolvedTarget.spaceId
                  );
                }}
              />
            </Suspense>
          </h1>
        </div>
        <div className="mt-4">{children}</div>
      </PageColumn>
    </>
  );
}
