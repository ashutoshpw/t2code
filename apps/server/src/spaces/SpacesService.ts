import {
  EnvironmentId,
  type SpacePageShare,
  type SpacePageShareId,
  type SpaceSharedDatabase,
  type SpaceSharedDatabaseRowPage,
  type SpaceSharedPage,
  type SpacesStorageStatus,
  type SpaceContextCaptureResult,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { openMediaFile } from "../assets/MediaFile.ts";
import * as Runtime from "./service/Runtime.ts";
import * as AssetOps from "./service/Assets.ts";
import * as ListOps from "./service/Lists.ts";
import * as DatabaseChangeOps from "./service/DatabaseChanges.ts";
import * as DatabaseReadOps from "./service/DatabaseReads.ts";
import * as ReadOps from "./service/Reads.ts";
import * as ShareOps from "./service/Shares.ts";
import * as SharedDatabaseOps from "./service/SharedDatabases.ts";
import type { QueryOutcome, QueryParams } from "./sharedDatabases/Read.ts";
import * as MutationOps from "./service/Mutations.ts";
import * as MaintenanceOps from "./service/Maintenance.ts";

export interface ResolvedAssetFile {
  readonly path: string;
  readonly digest: string;
  readonly byteSize: number;
  readonly name: string;
  readonly mimeType: C.SpaceAssetMetadata["mimeType"];
  readonly file: NonNullable<Effect.Success<ReturnType<typeof openMediaFile>>>;
}

export class SpacesService extends Context.Service<
  SpacesService,
  {
    readonly reclaimExistingStorage: Effect.Effect<void, C.SpaceServiceError>;
    readonly maintainAssets: Effect.Effect<SpacesStorageStatus | null, C.SpaceServiceError>;
    readonly createAssetUpload: (
      input: unknown,
      callerId: string,
    ) => Effect.Effect<
      C.SpaceAssetUploadCreateResult,
      C.SpaceServiceError,
      ServerSecretStore.ServerSecretStore
    >;
    readonly getAssetUpload: (
      input: unknown,
      callerId: string,
    ) => Effect.Effect<C.SpaceAssetUploadStatus, C.SpaceServiceError>;
    readonly finalizeAssetUpload: (
      input: unknown,
      callerId: string,
    ) => Effect.Effect<C.SpaceAssetMetadata, C.SpaceServiceError>;
    readonly listAssets: (
      input: unknown,
    ) => Effect.Effect<C.SpaceAssetListResult, C.SpaceServiceError>;
    readonly getAssetMetadata: (
      input: unknown,
    ) => Effect.Effect<C.SpaceAssetMetadata, C.SpaceServiceError>;
    readonly resolveAssetFile: (
      input: unknown,
    ) => Effect.Effect<ResolvedAssetFile, C.SpaceServiceError, Scope.Scope>;
    readonly receiveAssetUpload: <E, R>(
      token: string,
      contentLength: string | undefined,
      body: Stream.Stream<Uint8Array, E, R>,
    ) => Effect.Effect<
      C.SpaceAssetMetadata,
      C.SpaceServiceError,
      R | ServerSecretStore.ServerSecretStore
    >;
    readonly getCapability: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<C.SpaceCapability | null, C.SpaceServiceError>;
    // Inputs remain raw until the service's strict, size-bounded decoding boundary.
    readonly search: (input: unknown) => Effect.Effect<C.SpaceSearchResult, C.SpaceServiceError>;
    readonly listSpaces: (input: unknown) => Effect.Effect<C.SpaceListResult, C.SpaceServiceError>;
    readonly listPages: (
      input: unknown,
    ) => Effect.Effect<C.SpacePageListResult, C.SpaceServiceError>;
    readonly addPin: (input: unknown) => Effect.Effect<{}, C.SpaceServiceError>;
    readonly removePin: (input: unknown) => Effect.Effect<{}, C.SpaceServiceError>;
    readonly recordRecent: (input: unknown) => Effect.Effect<{}, C.SpaceServiceError>;
    readonly listPins: (
      input: unknown,
    ) => Effect.Effect<C.SpaceAllPagesResult, C.SpaceServiceError>;
    readonly listRecents: (
      input: unknown,
    ) => Effect.Effect<C.SpaceAllPagesResult, C.SpaceServiceError>;
    readonly listAllPages: (
      input: unknown,
    ) => Effect.Effect<C.SpaceAllPagesResult, C.SpaceServiceError>;
    readonly getPage: (input: unknown) => Effect.Effect<C.SpacePageGetResult, C.SpaceServiceError>;
    readonly readBlocks: (
      input: unknown,
    ) => Effect.Effect<C.SpaceReadBlocksResult, C.SpaceServiceError>;
    readonly createSpace: (
      input: unknown,
    ) => Effect.Effect<C.SpaceCreateResult, C.SpaceServiceError>;
    readonly renameSpace: (
      input: unknown,
    ) => Effect.Effect<C.SpaceRenameResult, C.SpaceServiceError>;
    readonly setDefaultSpace: (
      input: unknown,
    ) => Effect.Effect<C.SpaceSetDefaultResult, C.SpaceServiceError>;
    readonly createPage: (
      input: unknown,
    ) => Effect.Effect<C.SpacePageCreateResult, C.SpaceServiceError>;
    readonly updatePage: (
      input: unknown,
    ) => Effect.Effect<C.SpacePageUpdateResult, C.SpaceServiceError>;
    readonly applyBlockBatch: (
      input: unknown,
    ) => Effect.Effect<C.SpaceApplyBlockBatchResult, C.SpaceServiceError>;
    readonly createChildPage: (
      input: unknown,
    ) => Effect.Effect<C.SpaceCreateChildPageResult, C.SpaceServiceError>;
    readonly movePage: (
      input: unknown,
    ) => Effect.Effect<C.SpaceMovePageResult, C.SpaceServiceError>;
    readonly inspectStructure: (
      input: unknown,
    ) => Effect.Effect<C.SpaceInspectStructureResult, C.SpaceServiceError>;
    readonly moveBlocks: (
      input: unknown,
    ) => Effect.Effect<C.SpaceMoveBlocksResult, C.SpaceServiceError>;
    readonly captureContextSnapshot: (
      input: unknown,
    ) => Effect.Effect<SpaceContextCaptureResult, C.SpaceServiceError>;
    readonly resolveReference: (
      input: unknown,
    ) => Effect.Effect<C.SpaceReferenceResolveResult, C.SpaceServiceError>;
    readonly trashPage: (
      input: unknown,
    ) => Effect.Effect<C.SpacePageRecoveryResult, C.SpaceServiceError>;
    readonly restorePage: (
      input: unknown,
    ) => Effect.Effect<C.SpacePageRecoveryResult, C.SpaceServiceError>;
    readonly permanentlyDeletePage: (
      input: unknown,
    ) => Effect.Effect<C.SpacePagePurgeResult, C.SpaceServiceError>;
    readonly listTrash: (
      input: unknown,
    ) => Effect.Effect<C.SpaceTrashListResult, C.SpaceServiceError>;
    readonly createDatabase: (
      input: unknown,
    ) => Effect.Effect<C.SpaceDatabaseCreateResult, C.SpaceServiceError>;
    readonly updateDatabase: (
      input: unknown,
    ) => Effect.Effect<C.SpaceDatabaseUpdateResult, C.SpaceServiceError>;
    readonly createDataSource: (
      input: unknown,
    ) => Effect.Effect<C.SpaceDataSourceCreateResult, C.SpaceServiceError>;
    readonly updateDataSource: (
      input: unknown,
    ) => Effect.Effect<C.SpaceDataSourceUpdateResult, C.SpaceServiceError>;
    readonly deleteDataSource: (
      input: unknown,
    ) => Effect.Effect<C.SpaceDataSourceDeleteResult, C.SpaceServiceError>;
    readonly updateSchema: (
      input: unknown,
    ) => Effect.Effect<C.SpaceSchemaUpdateResult, C.SpaceServiceError>;
    readonly createView: (
      input: unknown,
    ) => Effect.Effect<C.SpaceViewCreateResult, C.SpaceServiceError>;
    readonly updateView: (
      input: unknown,
    ) => Effect.Effect<C.SpaceViewUpdateResult, C.SpaceServiceError>;
    readonly deleteView: (
      input: unknown,
    ) => Effect.Effect<C.SpaceViewDeleteResult, C.SpaceServiceError>;
    readonly createRows: (
      input: unknown,
    ) => Effect.Effect<C.SpaceRowsCreateResult, C.SpaceServiceError>;
    readonly updateRows: (
      input: unknown,
    ) => Effect.Effect<C.SpaceRowsUpdateResult, C.SpaceServiceError>;
    readonly moveRows: (
      input: unknown,
    ) => Effect.Effect<C.SpaceRowsMoveResult, C.SpaceServiceError>;
    readonly listDatabases: (
      input: unknown,
    ) => Effect.Effect<C.SpaceDatabaseListResult, C.SpaceServiceError>;
    readonly getDatabase: (
      input: unknown,
    ) => Effect.Effect<C.SpaceDatabaseGetResult, C.SpaceServiceError>;
    readonly queryDatabase: (
      input: unknown,
    ) => Effect.Effect<C.SpaceDatabaseQueryResult, C.SpaceServiceError>;
    readonly getDatabaseRows: (
      input: unknown,
    ) => Effect.Effect<C.SpaceDatabaseRowGetResult, C.SpaceServiceError>;
    /** Ids and revisions of what changed, starting with `resync`; refused like a read before it streams. */
    readonly subscribeDatabaseChanges: (
      input: unknown,
    ) => Stream.Stream<C.SpaceDatabaseChangeEvent, C.SpaceServiceError>;
    /** Brings every queued formula and rollup value up to date; returns when the queue is empty. */
    readonly drainComputed: Effect.Effect<void, C.SpaceServiceError>;
    /**
     * One pass of the dead-database and orphan-view sweep; true while a purge made progress.
     * `between` runs after the read half and before the write half.
     */
    readonly sweepDatabases: (
      between?: Effect.Effect<void, C.SpaceServiceError>,
    ) => Effect.Effect<boolean, C.SpaceServiceError>;
    readonly lookupMutationReceipt: (
      input: unknown,
    ) => Effect.Effect<C.SpaceReceiptLookupResult, C.SpaceServiceError>;
    /** Replaces the page's share, which ends its previous link. */
    readonly replacePageShare: (share: SpacePageShare) => Effect.Effect<void, C.SpaceServiceError>;
    readonly stopPageShare: (pageId: C.SpacePageId) => Effect.Effect<void, C.SpaceServiceError>;
    readonly findPageShare: (by: {
      readonly pageId: C.SpacePageId;
    }) => Effect.Effect<SpacePageShare | null, C.SpaceServiceError>;
    /**
     * The share behind a link and where the requested page sits in its tree, in one read.
     * `breadcrumb` is null when the page is not a live descendant of the root; `rootLive` says
     * whether the root itself still is.
     */
    readonly resolvePageShare: (input: {
      readonly shareId: SpacePageShareId;
      readonly pageId?: C.SpacePageId;
    }) => Effect.Effect<
      {
        readonly share: SpacePageShare;
        readonly pageId: C.SpacePageId;
        readonly breadcrumb: SpaceSharedPage["breadcrumb"] | null;
        readonly rootLive: boolean;
      } | null,
      C.SpaceServiceError
    >;
    /** One window of the page's blocks; `cursor` continues from a previous window's `nextCursor`. */
    readonly readSharedPage: (input: {
      readonly rootPageId: C.SpacePageId;
      readonly expiresAt: string;
      readonly pageId: C.SpacePageId;
      readonly breadcrumb: SpaceSharedPage["breadcrumb"];
      readonly cursor?: string;
    }) => Effect.Effect<SpaceSharedPage, C.SpaceServiceError>;
    /** Resolves an asset only when a live block of the page references it. */
    readonly resolveSharedAssetFile: (input: {
      readonly pageId: C.SpacePageId;
      readonly assetId: C.SpaceAssetId;
    }) => Effect.Effect<ResolvedAssetFile, C.SpaceServiceError, Scope.Scope>;
    /**
     * Public database reads for a share. Each takes the share's root page, reads only (no write
     * lock), and answers or fails with `SpaceNotFoundError` for anything outside the shared tree.
     * Cursors are the raw engine cursors; the share service seals them before they leave.
     */
    readonly describeSharedDatabase: (input: {
      readonly rootPageId: C.SpacePageId;
      readonly pageId: C.SpacePageId;
      readonly blockId: C.SpaceBlockId;
    }) => Effect.Effect<SpaceSharedDatabase, C.SpaceServiceError>;
    readonly querySharedDatabase: (input: {
      readonly rootPageId: C.SpacePageId;
      readonly pageId: C.SpacePageId;
      readonly blockId: C.SpaceBlockId;
      readonly viewId: C.SpaceViewId;
      readonly params: QueryParams;
    }) => Effect.Effect<QueryOutcome, C.SpaceServiceError>;
    readonly readSharedDatabaseRow: (input: {
      readonly rootPageId: C.SpacePageId;
      readonly pageId: C.SpacePageId;
      readonly blockId: C.SpaceBlockId;
      readonly viewId: C.SpaceViewId;
      readonly rowId: C.SpacePageId;
      readonly cursor?: string;
      readonly timeZone?: string;
    }) => Effect.Effect<SpaceSharedDatabaseRowPage, C.SpaceServiceError>;
    /** An asset of a row body, only while the row passes the saved view's filter. */
    readonly resolveSharedRowAssetFile: (input: {
      readonly rootPageId: C.SpacePageId;
      readonly pageId: C.SpacePageId;
      readonly blockId: C.SpaceBlockId;
      readonly viewId: C.SpaceViewId;
      readonly rowId: C.SpacePageId;
      readonly assetId: C.SpaceAssetId;
    }) => Effect.Effect<ResolvedAssetFile, C.SpaceServiceError, Scope.Scope>;
  }
>()("@t2code/cli/spaces/SpacesService") {}

const make = Effect.fn("SpacesService.make")(function* (
  dbPath: string,
  directories?: { readonly assetsDir: string; readonly stagingDir: string },
  options?: Runtime.RuntimeOptions,
) {
  const runtime = yield* Runtime.make(dbPath, directories, options);
  const assets = AssetOps.make(runtime);
  const lists = ListOps.make(runtime);
  const reads = ReadOps.make(runtime);
  const shares = ShareOps.make(runtime, assets);
  const sharedDatabases = SharedDatabaseOps.make(runtime, assets);
  const mutations = MutationOps.make(runtime);
  const databaseReads = DatabaseReadOps.make(runtime);
  const databaseChanges = DatabaseChangeOps.make(runtime);
  const maintenance = MaintenanceOps.make(runtime);
  return SpacesService.of({
    reclaimExistingStorage: maintenance.reclaimExistingStorage(),
    maintainAssets: maintenance.maintainAssets,
    createAssetUpload: assets.createAssetUpload,
    getAssetUpload: assets.getAssetUpload,
    finalizeAssetUpload: assets.finalizeAssetUpload,
    getAssetMetadata: assets.getAssetMetadata,
    resolveAssetFile: assets.resolveAssetFile,
    receiveAssetUpload: assets.receiveAssetUpload,
    getCapability: maintenance.getCapability,
    search: reads.search,
    listSpaces: lists.listSpaces,
    listPages: lists.listPages,
    listAllPages: lists.listAllPages,
    addPin: lists.addPin,
    removePin: lists.removePin,
    listPins: lists.listPins,
    recordRecent: lists.recordRecent,
    listRecents: lists.listRecents,
    listAssets: assets.listAssets,
    getPage: reads.getPage,
    readBlocks: reads.readBlocks,
    createSpace: mutations.createSpace,
    renameSpace: mutations.renameSpace,
    setDefaultSpace: mutations.setDefaultSpace,
    createPage: mutations.createPage,
    updatePage: mutations.updatePage,
    applyBlockBatch: mutations.applyBlockBatch,
    drainComputed: runtime.drainComputed(),
    sweepDatabases: runtime.sweepDatabases,
    lookupMutationReceipt: mutations.lookupMutationReceipt,
    createDatabase: mutations.createDatabase,
    updateDatabase: mutations.updateDatabase,
    createDataSource: mutations.createDataSource,
    updateDataSource: mutations.updateDataSource,
    deleteDataSource: mutations.deleteDataSource,
    updateSchema: mutations.updateSchema,
    createView: mutations.createView,
    updateView: mutations.updateView,
    deleteView: mutations.deleteView,
    createRows: mutations.createRows,
    updateRows: mutations.updateRows,
    moveRows: mutations.moveRows,
    listDatabases: databaseReads.listDatabases,
    getDatabase: databaseReads.getDatabase,
    queryDatabase: databaseReads.queryDatabase,
    getDatabaseRows: databaseReads.getDatabaseRows,
    subscribeDatabaseChanges: databaseChanges.subscribeDatabaseChanges,
    createChildPage: mutations.createChildPage,
    movePage: mutations.movePage,
    inspectStructure: reads.inspectStructure,
    moveBlocks: mutations.moveBlocks,
    resolveReference: reads.resolveReference,
    trashPage: mutations.trashPage,
    restorePage: mutations.restorePage,
    permanentlyDeletePage: mutations.permanentlyDeletePage,
    listTrash: lists.listTrash,
    captureContextSnapshot: reads.captureContextSnapshot,
    replacePageShare: shares.replacePageShare,
    stopPageShare: shares.stopPageShare,
    findPageShare: shares.findPageShare,
    resolvePageShare: shares.resolvePageShare,
    readSharedPage: shares.readSharedPage,
    resolveSharedAssetFile: shares.resolveSharedAssetFile,
    describeSharedDatabase: sharedDatabases.describeSharedDatabase,
    querySharedDatabase: sharedDatabases.querySharedDatabase,
    readSharedDatabaseRow: sharedDatabases.readSharedDatabaseRow,
    resolveSharedRowAssetFile: sharedDatabases.resolveSharedRowAssetFile,
  });
});

export const layerFromPath = (
  dbPath: string,
  directories?: { readonly assetsDir: string; readonly stagingDir: string },
  options?: Runtime.RuntimeOptions,
) => Layer.effect(SpacesService, make(dbPath, directories, options));
