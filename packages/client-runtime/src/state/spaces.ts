import {
  SpacesUnavailableError,
  type SpaceCapability,
  type SpaceAssetUploadInput,
  type SpaceAssetGetInput,
} from "@t2code/contracts/spaces";
import { WS_METHODS, type EnvironmentId, type SpacePageShareLink } from "@t2code/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { createSpacesDatabaseAtoms } from "./spacesDatabases.ts";
import { createSpacesCommentAtoms } from "./spacesComments.ts";
import { createSpacesPageAtoms } from "./spacesPages.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { readSpacePageLocation, SpaceLocationError } from "../spaces/pageLocation.ts";
import type { SpaceBlockId, SpacePageId, SpacePageSummary } from "@t2code/contracts/spaces";
import { request, requestGuarded } from "../rpc/client.ts";
import {
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export type SpacesAvailability =
  | "disconnected"
  | "unavailable"
  | "unsupported-version"
  | "denied"
  | "read-only"
  | "writable";

export function spacesAvailability(input: {
  readonly connected: boolean;
  readonly capability: Pick<SpaceCapability, "version"> | undefined;
  readonly canRead: boolean;
  readonly canOperate: boolean;
}): SpacesAvailability {
  if (!input.connected) return "disconnected";
  if (!input.capability) return "unavailable";
  if (input.capability.version !== 1 && input.capability.version !== 2)
    return "unsupported-version";
  if (!input.canRead) return "denied";
  return input.canOperate ? "writable" : "read-only";
}

export function canBrowseSpaces(availability: SpacesAvailability) {
  return availability === "read-only" || availability === "writable";
}

export function createSpacesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options?: {
    readonly capabilityAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<SpaceCapability | undefined>;
  },
) {
  const changed = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  const refreshTrigger = ({ environmentId }: { environmentId: EnvironmentId }) =>
    changed(environmentId);
  const libraryChanged = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  const libraryRefresh = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(changed(environmentId)) + get(libraryChanged(environmentId))),
  );
  const pageShares = Atom.family((_key: string) =>
    Atom.make<SpacePageShareLink | null | undefined>(undefined).pipe(Atom.keepAlive),
  );
  const pageShare = (environmentId: EnvironmentId, pageId: SpacePageId) =>
    pageShares(`${environmentId}\n${pageId}`);
  const syncedSourcePages = Atom.family((_key: string) =>
    Atom.make<SpacePageId | undefined>(undefined).pipe(Atom.keepAlive),
  );
  const databases = createSpacesDatabaseAtoms(runtime, options);
  const pages = createSpacesPageAtoms(runtime, {
    ...(options ? { capabilityAtom: options.capabilityAtom } : {}),
    changed,
  });
  const comments = createSpacesCommentAtoms(runtime, {
    ...(options ? { capabilityAtom: options.capabilityAtom } : {}),
    commentLive: pages.commentLive,
  });
  // A copy refreshes with the library and, once an answer named the original's page, with that page's live signal.
  const syncedTrigger = Atom.family((key: string) => {
    const [environmentId] = JSON.parse(key) as [EnvironmentId, SpaceBlockId];
    return Atom.make((get) => {
      const pageId = get(syncedSourcePages(key));
      const live = pageId === undefined ? undefined : get(pages.pageLive(environmentId, pageId));
      return get(changed(environmentId)) + (live ? live.changeSeq + live.resyncSeq : 0);
    });
  });
  return {
    changed,
    pageLive: pages.pageLive,
    commentLive: pages.commentLive,
    comments,
    treeLive: pages.treeLive,
    libraryChanged,
    databases,
    /**
     * The page's current share link as last read or written here: undefined before the first
     * read, null once stopped. An expired link stays until the owner stops or replaces it.
     */
    pageShare,
    getPageShare: createEnvironmentRpcCommand(runtime, {
      label: "spaces.shares.get",
      tag: WS_METHODS.spacesSharesGet,
      onSuccess: (target, registry, result) =>
        Effect.sync(() =>
          registry.set(pageShare(target.environmentId, target.input.pageId), result.link),
        ),
    }),
    createPageShare: createEnvironmentRpcCommand(runtime, {
      label: "spaces.shares.create",
      tag: WS_METHODS.spacesSharesCreate,
      onSuccess: (target, registry, result) =>
        Effect.sync(() =>
          registry.set(pageShare(target.environmentId, target.input.pageId), result),
        ),
    }),
    stopPageShare: createEnvironmentRpcCommand(runtime, {
      label: "spaces.shares.stop",
      tag: WS_METHODS.spacesSharesStop,
      onSuccess: (target, registry) =>
        Effect.sync(() => registry.set(pageShare(target.environmentId, target.input.pageId), null)),
    }),
    createImageUpload: createEnvironmentRpcCommand(runtime, {
      label: "spaces.image-upload-create",
      tag: WS_METHODS.spacesAssetsUploadCreate,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const c = options ? registry.get(options.capabilityAtom(input.environmentId)) : undefined;
          return c?.version === 2 && c.features?.assets === true && c.limits.assets
            ? requestGuarded(WS_METHODS.spacesAssetsUploadCreate, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
    }),
    finalizeImageUpload: createEnvironmentRpcCommand(runtime, {
      label: "spaces.image-upload-finalize",
      tag: WS_METHODS.spacesAssetsUploadFinalize,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const c = options ? registry.get(options.capabilityAtom(input.environmentId)) : undefined;
          return c?.version === 2 && c.features?.assets === true && c.limits.assets
            ? requestGuarded(WS_METHODS.spacesAssetsUploadFinalize, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
    }),
    imageUpload: createEnvironmentQueryAtomFamily(runtime, {
      label: "spaces.image-upload-status",
      idleTtlMs: 0,
      staleTimeMs: 0,
      execute: Effect.fn("Spaces.imageUpload")(function* (input: SpaceAssetUploadInput) {
        const registry = yield* AtomRegistry.AtomRegistry;
        const c = options ? registry.get(options.capabilityAtom(input.environmentId)) : undefined;
        if (c?.version !== 2 || c.features?.assets !== true || !c.limits.assets)
          return yield* new SpacesUnavailableError({ stage: "settings" });
        return yield* requestGuarded(WS_METHODS.spacesAssetsUploadGet, input);
      }),
    }),
    imageMetadata: createEnvironmentQueryAtomFamily(runtime, {
      label: "spaces.image-metadata",
      idleTtlMs: 0,
      staleTimeMs: 0,
      execute: Effect.fn("Spaces.imageMetadata")(function* (input: SpaceAssetGetInput) {
        const registry = yield* AtomRegistry.AtomRegistry;
        const c = options ? registry.get(options.capabilityAtom(input.environmentId)) : undefined;
        if (c?.version !== 2 || c.features?.assets !== true || !c.limits.assets)
          return yield* new SpacesUnavailableError({ stage: "settings" });
        return yield* requestGuarded(WS_METHODS.spacesAssetsGet, input);
      }),
    }),
    captureSession: createEnvironmentCommand(runtime, {
      label: "spaces.captureSession",
      execute: Effect.fn("Spaces.captureSession")(function* (_input: undefined) {
        const supervisor = yield* EnvironmentSupervisor;
        const session = Option.getOrNull(SubscriptionRef.getUnsafe(supervisor.session));
        const initial = SubscriptionRef.getUnsafe(supervisor.state);
        return () => {
          const now = SubscriptionRef.getUnsafe(supervisor.state);
          return now.phase === "connected" &&
            now.generation === initial.generation &&
            now.attempt === initial.attempt &&
            Option.getOrNull(SubscriptionRef.getUnsafe(supervisor.session)) === session
            ? session
            : null;
        };
      }),
    }),
    search: createEnvironmentRpcCommand(runtime, {
      label: "spaces.search",
      tag: WS_METHODS.spacesSearch,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const c = options ? registry.get(options.capabilityAtom(input.environmentId)) : undefined;
          return c?.version === 2 && c.features?.search === true
            ? requestGuarded(WS_METHODS.spacesSearch, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
    }),
    resolve: createEnvironmentRpcCommand(runtime, {
      label: "spaces.resolve",
      tag: WS_METHODS.spacesReferencesResolve,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const c = options ? registry.get(options.capabilityAtom(input.environmentId)) : undefined;
          return c?.version === 2 && c.features?.referenceResolution === true
            ? requestGuarded(WS_METHODS.spacesReferencesResolve, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
    }),

    blocks: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:spaces:blocks",
      tag: WS_METHODS.spacesBlocksRead,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    /** The original behind a synced copy: its blocks, copies and page; refreshes with live changes to its page. */
    readSubtree: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:spaces:readSubtree",
      tag: WS_METHODS.spacesBlocksReadSubtree,
      idleTtlMs: 0,
      staleTimeMs: 0,
      refreshTrigger: ({ environmentId, input }) =>
        syncedTrigger(JSON.stringify([environmentId, input.blockId])),
      onAnswer: ({ environmentId, input }, value, registry) => {
        const atom = syncedSourcePages(JSON.stringify([environmentId, input.blockId]));
        return Effect.sync(() =>
          registry.set(atom, value.status === "found" ? value.page.id : undefined),
        );
      },
    }),
    unsync: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:unsync",
      tag: WS_METHODS.spacesBlocksUnsync,
    }),
    receipt: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:spaces:receipt",
      tag: WS_METHODS.spacesReceiptsGet,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    inspect: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:spaces:inspect",
      tag: WS_METHODS.spacesStructureInspect,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    createSpace: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:createSpace",
      tag: WS_METHODS.spacesCreate,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const capability = options
            ? registry.get(options.capabilityAtom(input.environmentId))
            : undefined;
          return capability?.version === 1 || capability?.version === 2
            ? requestGuarded(WS_METHODS.spacesCreate, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
    }),
    renameSpace: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:renameSpace",
      tag: WS_METHODS.spacesRename,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const capability = options
            ? registry.get(options.capabilityAtom(input.environmentId))
            : undefined;
          return capability?.version === 1 || capability?.version === 2
            ? requestGuarded(WS_METHODS.spacesRename, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
    }),
    setDefaultSpace: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:setDefaultSpace",
      tag: WS_METHODS.spacesSetDefault,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const capability = options
            ? registry.get(options.capabilityAtom(input.environmentId))
            : undefined;
          return capability?.version === 1 || capability?.version === 2
            ? requestGuarded(WS_METHODS.spacesSetDefault, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
    }),
    createPage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:createPage",
      tag: WS_METHODS.spacesPagesCreate,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const capability = options
            ? registry.get(options.capabilityAtom(input.environmentId))
            : undefined;
          return capability?.version === 1 || capability?.version === 2
            ? requestGuarded(WS_METHODS.spacesPagesCreate, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
    }),
    updatePage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:updatePage",
      tag: WS_METHODS.spacesPagesUpdate,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const capability = options
            ? registry.get(options.capabilityAtom(input.environmentId))
            : undefined;
          return capability?.version === 1 || capability?.version === 2
            ? requestGuarded(WS_METHODS.spacesPagesUpdate, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
      // A row's title, icon, trash state or existence is a cell of its data source.
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          databases.rowPageChanged(registry, target.environmentId, target.input.pageId);
          if (result.status === "saved")
            databases.dataSourcesChanged(
              registry,
              target.environmentId,
              result.affectedDataSourceIds ?? [],
            );
        }),
    }),
    moveBlocks: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:move-blocks",
      tag: WS_METHODS.spacesBlocksMove,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const capability = options
            ? registry.get(options.capabilityAtom(input.environmentId))
            : undefined;
          return capability?.version === 2 && capability.features?.blockMoves === true
            ? requestGuarded(WS_METHODS.spacesBlocksMove, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
    }),
    createChild: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:create-child",
      tag: WS_METHODS.spacesPagesCreateChild,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const c = options ? registry.get(options.capabilityAtom(input.environmentId)) : undefined;
          return c?.version === 2
            ? requestGuarded(WS_METHODS.spacesPagesCreateChild, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
    }),
    trashPage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:trash-page",
      tag: WS_METHODS.spacesPagesTrash,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const c = options ? registry.get(options.capabilityAtom(input.environmentId)) : undefined;
          return c?.version === 2 && c.features?.recovery === true
            ? requestGuarded(WS_METHODS.spacesPagesTrash, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          databases.rowPageChanged(registry, target.environmentId, target.input.pageId);
          if (result.status === "saved")
            databases.dataSourcesChanged(
              registry,
              target.environmentId,
              result.affectedDataSourceIds ?? [],
            );
        }),
    }),
    restorePage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:restore-page",
      tag: WS_METHODS.spacesPagesRestore,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const c = options ? registry.get(options.capabilityAtom(input.environmentId)) : undefined;
          return c?.version === 2 && c.features?.recovery === true
            ? requestGuarded(WS_METHODS.spacesPagesRestore, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          databases.rowPageChanged(registry, target.environmentId, target.input.pageId);
          if (result.status === "saved")
            databases.dataSourcesChanged(
              registry,
              target.environmentId,
              result.affectedDataSourceIds ?? [],
            );
        }),
    }),
    permanentlyDeletePage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:permanently-delete-page",
      tag: WS_METHODS.spacesPagesPermanentlyDelete,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const c = options ? registry.get(options.capabilityAtom(input.environmentId)) : undefined;
          return c?.version === 2 && c.features?.recovery === true
            ? requestGuarded(WS_METHODS.spacesPagesPermanentlyDelete, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          const ids =
            result.status === "saved" ? [target.input.pageId, ...result.deletedPageIds] : [];
          for (const id of new Set(ids))
            databases.rowPageChanged(registry, target.environmentId, id);
          if (result.status === "saved")
            databases.dataSourcesChanged(
              registry,
              target.environmentId,
              result.affectedDataSourceIds ?? [],
            );
        }),
    }),
    trash: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:spaces:trash",
      tag: WS_METHODS.spacesTrashList,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    movePage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:move-page",
      tag: WS_METHODS.spacesPagesMove,
    }),
    apply: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:apply",
      tag: WS_METHODS.spacesBlocksApply,
    }),
    capture: createEnvironmentRpcCommand(runtime, {
      label: "spaces.captureContextSnapshot",
      tag: WS_METHODS.spacesContextCapture,
    }),
    // Each caller owns this query; sharing its SWR cache could authorize an obsolete location.
    location: (target: {
      environmentId: EnvironmentId;
      input: { environmentId: EnvironmentId; pageId: SpacePageId; version: 1 | 2 };
    }) =>
      createEnvironmentQueryAtomFamily(runtime, {
        refreshTrigger,
        label: "environment-data:spaces:location",
        idleTtlMs: 0,
        staleTimeMs: 0,
        execute: Effect.fn("Spaces.readCurrentLocation")(function* (input: {
          environmentId: EnvironmentId;
          pageId: SpacePageId;
          version: 1 | 2;
        }) {
          const supervisor = yield* EnvironmentSupervisor;
          const state = SubscriptionRef.getUnsafe(supervisor.state);
          const session = SubscriptionRef.getUnsafe(supervisor.session);
          const isCurrent = () => {
            const active = SubscriptionRef.getUnsafe(supervisor.session);
            return (
              state.phase === "connected" &&
              SubscriptionRef.getUnsafe(supervisor.state) === state &&
              Option.isSome(session) &&
              Option.isSome(active) &&
              session.value === active.value
            );
          };
          const registry = yield* AtomRegistry.AtomRegistry;
          const capability = options?.capabilityAtom
            ? registry.get(options.capabilityAtom(input.environmentId))
            : undefined;
          const unavailable = () =>
            new SpaceLocationError({ message: "This row's database is unavailable." });
          // A row lives in a database block of its host page; the database record names that page.
          const readRowHost = Effect.fn("Spaces.readRowHost")(function* (page: SpacePageSummary) {
            if (capability?.features?.databases !== true) return yield* unavailable();
            const row = yield* requestGuarded(WS_METHODS.spacesDatabasesRowsGet, {
              environmentId: input.environmentId,
              pageId: page.id,
              properties: [],
            }).pipe(Effect.mapError(unavailable));
            const database = yield* requestGuarded(WS_METHODS.spacesDatabasesGet, {
              environmentId: input.environmentId,
              databaseId: row.dataSource.databaseId,
            }).pipe(Effect.mapError(unavailable));
            const home = database.database.home;
            if (home === null || !database.database.live) return yield* unavailable();
            return { hostPageId: home.pageId };
          });
          return yield* readSpacePageLocation(
            input,
            (pageId) =>
              request(WS_METHODS.spacesPagesGet, { environmentId: input.environmentId, pageId }),
            readRowHost,
          ).pipe(
            Effect.matchEffect({
              onFailure: (error) => (isCurrent() ? Effect.fail(error) : Effect.never),
              onSuccess: (data) =>
                isCurrent()
                  ? Effect.succeed({ ...data, current: () => (isCurrent() ? data : null) })
                  : Effect.never,
            }),
          );
        }),
      })(target),
    allPages: createEnvironmentRpcQueryAtomFamily(runtime, {
      refreshTrigger: ({ environmentId }) => libraryRefresh(environmentId),
      label: "environment-data:spaces:allPages",
      tag: WS_METHODS.spacesPagesListAll,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    assets: createEnvironmentRpcQueryAtomFamily(runtime, {
      refreshTrigger: ({ environmentId }) => libraryRefresh(environmentId),
      label: "environment-data:spaces:assets",
      tag: WS_METHODS.spacesAssetsList,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    pins: createEnvironmentRpcQueryAtomFamily(runtime, {
      refreshTrigger: ({ environmentId }) => libraryRefresh(environmentId),
      label: "environment-data:spaces:pins",
      tag: WS_METHODS.spacesPinsList,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    recents: createEnvironmentRpcQueryAtomFamily(runtime, {
      refreshTrigger: ({ environmentId }) => libraryRefresh(environmentId),
      label: "environment-data:spaces:recents",
      tag: WS_METHODS.spacesRecentsList,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    addPin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:addPin",
      tag: WS_METHODS.spacesPinsAdd,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const c = options ? registry.get(options.capabilityAtom(input.environmentId)) : undefined;
          return c?.features?.pins === true
            ? requestGuarded(WS_METHODS.spacesPinsAdd, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
    }),
    removePin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:removePin",
      tag: WS_METHODS.spacesPinsRemove,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const c = options ? registry.get(options.capabilityAtom(input.environmentId)) : undefined;
          return c?.features?.pins === true
            ? requestGuarded(WS_METHODS.spacesPinsRemove, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
    }),
    recordRecent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:recordRecent",
      tag: WS_METHODS.spacesRecentsRecord,
      execute: (input, registry) =>
        Effect.suspend(() => {
          const c = options ? registry.get(options.capabilityAtom(input.environmentId)) : undefined;
          return c?.features?.recents === true
            ? requestGuarded(WS_METHODS.spacesRecentsRecord, input)
            : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));
        }),
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      refreshTrigger,
      label: "environment-data:spaces:list",
      tag: WS_METHODS.spacesList,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    pages: createEnvironmentRpcQueryAtomFamily(runtime, {
      refreshTrigger,
      label: "environment-data:spaces:pages",
      tag: WS_METHODS.spacesPagesList,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    page: createEnvironmentRpcQueryAtomFamily(runtime, {
      refreshTrigger,
      label: "environment-data:spaces:page",
      tag: WS_METHODS.spacesPagesGet,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
  };
}
