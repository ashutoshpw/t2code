import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import {
  SpaceAssetId,
  SpaceBlockId,
  SpaceCursor,
  SpaceId,
  SpaceMutationAdmission,
  SpacePageIcon,
  SpacePageId,
  SpaceRichText,
  StableId,
  mutationAck,
  mutationInput,
  spaceBlockBase as blockBase,
} from "./spacesCore.ts";
import { SpaceListInput } from "./spacesCapability.ts";
import {
  SPACE_SYNCED_REFS_LISTED,
  SpaceSyncedRefSummary,
  SpaceUnsyncInput,
  SpaceUnsyncResult,
} from "./spacesSynced.ts";

import {
  SpaceDatabaseCreateInput,
  SpaceDatabaseCreateResult,
  SpaceDatabaseUpdateInput,
  SpaceDatabaseUpdateResult,
  SpaceDataSourceCreateInput,
  SpaceDataSourceCreateResult,
  SpaceDataSourceDeleteInput,
  SpaceDataSourceDeleteResult,
  SpaceDataSourceUpdateInput,
  SpaceDataSourceUpdateResult,
  SpaceRowsCreateInput,
  SpaceRowsCreateResult,
  SpaceRowsMoveInput,
  SpaceRowsMoveResult,
  SpaceRowsUpdateInput,
  SpaceRowsUpdateResult,
  SpaceSchemaUpdateInput,
  SpaceSchemaUpdateResult,
  SpaceViewCreateInput,
  SpaceViewCreateResult,
  SpaceViewDeleteInput,
  SpaceViewDeleteResult,
  SpaceViewUpdateInput,
  SpaceViewUpdateResult,
} from "./spacesDatabaseMutations.ts";
import { SpaceDataSourceId } from "./spacesDatabases.ts";

export * from "./spacesCore.ts";
export * from "./spacesDatabases.ts";
export * from "./spacesDatabaseFilters.ts";
export * from "./spacesDatabaseViews.ts";
export * from "./spacesDatabaseQuery.ts";
export * from "./spacesDatabaseMutations.ts";
export * from "./spacesDatabaseChanges.ts";
export * from "./spacesBlockKinds.ts";
export * from "./spacesSynced.ts";

const textContent = { runs: SpaceRichText };
export const SpaceKnownBlock = Schema.Union([
  Schema.Struct({
    ...blockBase,
    type: Schema.Literals(["paragraph", "quote", "bulleted_item", "numbered_item", "toggle"]),
    content: Schema.Struct(textContent),
  }),
  Schema.Struct({
    ...blockBase,
    type: Schema.Literal("heading"),
    content: Schema.Struct({ ...textContent, level: Schema.Literals([1, 2, 3]) }),
  }),
  Schema.Struct({
    ...blockBase,
    type: Schema.Literal("todo_item"),
    content: Schema.Struct({ ...textContent, checked: Schema.Boolean }),
  }),
  Schema.Struct({
    ...blockBase,
    type: Schema.Literal("callout"),
    content: Schema.Struct({ ...textContent, icon: Schema.String }),
  }),
  Schema.Struct({
    ...blockBase,
    type: Schema.Literal("code"),
    content: Schema.Struct({ text: Schema.String, language: Schema.String }),
  }),
  Schema.Struct({ ...blockBase, type: Schema.Literal("divider"), content: Schema.Struct({}) }),
  Schema.Struct({
    ...blockBase,
    type: Schema.Literals(["image", "pdf", "video"]),
    content: Schema.Struct({ assetId: SpaceAssetId, caption: Schema.optionalKey(SpaceRichText) }),
  }),
  Schema.Struct({
    ...blockBase,
    type: Schema.Literal("child_page"),
    content: Schema.Struct({ pageId: SpacePageId }),
  }),
]);
export type SpaceKnownBlock = typeof SpaceKnownBlock.Type;

// Decode the envelope without routing future payloads through a lossy known-type union.
export const SpaceBlock = Schema.StructWithRest(
  Schema.Struct({ ...blockBase, type: StableId, version: PositiveInt, content: Schema.Json }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type SpaceBlock = typeof SpaceBlock.Type;
export const SpaceBlockWindow = Schema.Struct({
  revision: NonNegativeInt,
  blocks: Schema.Array(SpaceBlock),
});
export type SpaceBlockWindow = typeof SpaceBlockWindow.Type;

// Production boundaries must decode with onExcessProperty: "error" before fingerprinting;
// Struct's default strips fields. Enforce the fixed 1 MiB protocol ceiling before decoding,
// then replay retained receipts before checking current service limits or epoch deadlines.

export const SpaceSummary = Schema.Struct({
  id: SpaceId,
  title: Schema.String,
  isDefault: Schema.Boolean,
  revision: NonNegativeInt,
  rootOrderRevision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SpaceSummary = typeof SpaceSummary.Type;
export const SpacePageLocation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("root"), spaceId: SpaceId, order: StableId }),
  Schema.Struct({
    kind: Schema.Literal("child"),
    spaceId: SpaceId,
    ownerBlockId: SpaceBlockId,
    parentPageId: SpacePageId,
  }),
]);
export type SpacePageLocation = typeof SpacePageLocation.Type;
export const SpacePageTrashStatus = Schema.Struct({
  batchId: StableId,
  originalRootPageId: SpacePageId,
  trashedAt: IsoDateTime,
});
export type SpacePageTrashStatus = typeof SpacePageTrashStatus.Type;
export const SpacePageSummary = Schema.Struct({
  id: SpacePageId,
  spaceId: SpaceId,
  title: Schema.String,
  icon: Schema.optionalKey(SpacePageIcon),
  revision: NonNegativeInt,
  rootOrder: Schema.NullOr(StableId),
  hasChildren: Schema.optionalKey(Schema.Boolean),
  isPinned: Schema.optionalKey(Schema.Boolean),
  location: Schema.optionalKey(SpacePageLocation),
  // Set instead of `location` for a database row; the location union stays closed for older clients.
  row: Schema.optionalKey(Schema.Struct({ dataSourceId: SpaceDataSourceId })),
  trash: Schema.optionalKey(SpacePageTrashStatus),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SpacePageSummary = typeof SpacePageSummary.Type;

export const SpaceBlockMutation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("insert"), block: SpaceBlock }),
  Schema.Struct({ kind: Schema.Literal("replace"), block: SpaceBlock }),
  Schema.Struct({
    kind: Schema.Literal("delete"),
    blockId: SpaceBlockId,
    mergedInto: Schema.optionalKey(SpaceBlockId),
  }),
]);
export type SpaceBlockMutation = typeof SpaceBlockMutation.Type;

export const SpaceMutationConflict = Schema.Struct({
  status: Schema.Literal("conflict"),
  ...mutationAck,
  current: Schema.Struct({
    catalogRevision: NonNegativeInt,
    defaultSpaceId: SpaceId,
    spaces: Schema.Array(SpaceSummary).check(Schema.isMaxLength(2)),
    pages: Schema.Array(SpacePageSummary).check(Schema.isMaxLength(1)),
  }),
});
export type SpaceMutationConflict = typeof SpaceMutationConflict.Type;

export const SpaceListResult = Schema.Struct({
  items: Schema.Array(SpaceSummary),
  defaultSpaceId: SpaceId,
  catalogRevision: NonNegativeInt,
  nextCursor: Schema.NullOr(SpaceCursor),
  mutationAdmission: SpaceMutationAdmission,
});
export type SpaceListResult = typeof SpaceListResult.Type;
export const SpacePageListInput = Schema.Struct({
  ...SpaceListInput.fields,
  spaceId: SpaceId,
  parentPageId: Schema.optionalKey(SpacePageId),
});
export type SpacePageListInput = typeof SpacePageListInput.Type;
export const SpacePageListResult = Schema.Struct({
  space: SpaceSummary,
  items: Schema.Array(SpacePageSummary),
  catalogRevision: NonNegativeInt,
  nextCursor: Schema.NullOr(SpaceCursor),
  mutationAdmission: SpaceMutationAdmission,
});
export type SpacePageListResult = typeof SpacePageListResult.Type;
export const SpaceAllPagesResult = Schema.Struct({
  items: Schema.Array(Schema.Struct({ page: SpacePageSummary, spaceTitle: Schema.String })),
  catalogRevision: NonNegativeInt,
  nextCursor: Schema.NullOr(SpaceCursor),
});
export type SpaceAllPagesResult = typeof SpaceAllPagesResult.Type;
export const SpaceSearchInput = Schema.Struct({
  ...SpaceListInput.fields,
  spaceId: Schema.optionalKey(SpaceId),
  query: Schema.String,
});
export type SpaceSearchInput = typeof SpaceSearchInput.Type;
export const SpaceSearchResult = Schema.Struct({
  catalogRevision: NonNegativeInt,
  items: Schema.Array(
    Schema.Struct({
      page: SpacePageSummary,
      blockId: Schema.optionalKey(SpaceBlockId),
      snippet: Schema.String,
    }),
  ),
  nextCursor: Schema.NullOr(SpaceCursor),
});
export type SpaceSearchResult = typeof SpaceSearchResult.Type;

export const SpacePageGetInput = Schema.Struct({
  environmentId: EnvironmentId,
  pageId: SpacePageId,
});
export type SpacePageGetInput = typeof SpacePageGetInput.Type;
export const SpacePageGetResult = Schema.Struct({
  page: SpacePageSummary,
  space: SpaceSummary,
  mutationAdmission: SpaceMutationAdmission,
});
export type SpacePageGetResult = typeof SpacePageGetResult.Type;
export const SpaceReadBlocksInput = Schema.Struct({
  ...SpaceListInput.fields,
  pageId: SpacePageId,
  revision: NonNegativeInt,
});
export type SpaceReadBlocksInput = typeof SpaceReadBlocksInput.Type;
export const SpaceReadBlocksResult = Schema.Struct({
  ...SpaceBlockWindow.fields,
  nextCursor: Schema.NullOr(SpaceCursor),
});
export type SpaceReadBlocksResult = typeof SpaceReadBlocksResult.Type;

export const SpaceReadSubtreeResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("found"),
    page: SpacePageSummary,
    mutationAdmission: SpaceMutationAdmission,
    revision: NonNegativeInt,
    /** The synced_block first, then its descendants in tree order. */
    blocks: Schema.Array(SpaceBlock),
    complete: Schema.Boolean,
    refs: Schema.Array(SpaceSyncedRefSummary).check(Schema.isMaxLength(SPACE_SYNCED_REFS_LISTED)),
    refCount: NonNegativeInt,
  }),
  Schema.Struct({ status: Schema.Literal("deleted") }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
export type SpaceReadSubtreeResult = typeof SpaceReadSubtreeResult.Type;

export const SpaceCreateInput = Schema.Struct({ ...mutationInput, title: Schema.String });
export type SpaceCreateInput = typeof SpaceCreateInput.Type;
export const SpaceCreateResult = Schema.Struct({
  status: Schema.Literal("saved"),
  ...mutationAck,
  space: SpaceSummary,
});
export type SpaceCreateResult = typeof SpaceCreateResult.Type;
export const SpaceRenameInput = Schema.Struct({
  ...mutationInput,
  spaceId: SpaceId,
  baseRevision: NonNegativeInt,
  title: Schema.String,
});
export type SpaceRenameInput = typeof SpaceRenameInput.Type;
export const SpaceRenameResult = Schema.Union([SpaceCreateResult, SpaceMutationConflict]);
export type SpaceRenameResult = typeof SpaceRenameResult.Type;
export const SpaceSetDefaultInput = Schema.Struct({
  ...mutationInput,
  spaceId: SpaceId,
  baseRevision: NonNegativeInt,
  defaultSpaceId: SpaceId,
  baseDefaultRevision: NonNegativeInt,
});
export type SpaceSetDefaultInput = typeof SpaceSetDefaultInput.Type;
export const SpaceSetDefaultResult = Schema.Union([
  Schema.Struct({ ...SpaceCreateResult.fields, previousDefaultSpace: SpaceSummary }),
  SpaceMutationConflict,
]);
export type SpaceSetDefaultResult = typeof SpaceSetDefaultResult.Type;
export const SpacePageCreateInput = Schema.Struct({
  ...mutationInput,
  spaceId: SpaceId,
  baseRootOrderRevision: NonNegativeInt,
  title: Schema.String,
});
export type SpacePageCreateInput = typeof SpacePageCreateInput.Type;
export const SpacePageCreateResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved"),
    ...mutationAck,
    page: SpacePageSummary,
    space: SpaceSummary,
  }),
  SpaceMutationConflict,
]);
export type SpacePageCreateResult = typeof SpacePageCreateResult.Type;
export const SpacePageUpdateInput = Schema.Struct({
  ...mutationInput,
  pageId: SpacePageId,
  baseRevision: NonNegativeInt,
  title: Schema.String,
  /** Absent keeps the icon, null clears it. */
  icon: Schema.optionalKey(Schema.NullOr(SpacePageIcon)),
});
export type SpacePageUpdateInput = typeof SpacePageUpdateInput.Type;
export const SpacePageUpdateResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved"),
    ...mutationAck,
    page: SpacePageSummary,
    /** Data sources whose computed values changed with this edit. */
    affectedDataSourceIds: Schema.optionalKey(Schema.Array(SpaceDataSourceId)),
  }),
  SpaceMutationConflict,
]);
export type SpacePageUpdateResult = typeof SpacePageUpdateResult.Type;
export const SpaceApplyBlockBatchInput = Schema.Struct({
  ...mutationInput,
  pageId: SpacePageId,
  baseRevision: NonNegativeInt,
  generation: NonNegativeInt,
  mutations: Schema.Array(SpaceBlockMutation),
  /** Confines the batch to the descendants of this synced_block on the page. */
  subtreeRootId: Schema.optionalKey(SpaceBlockId),
});
export type SpaceApplyBlockBatchInput = typeof SpaceApplyBlockBatchInput.Type;
const blockAck = { generation: NonNegativeInt, revision: NonNegativeInt };
export const SpaceApplyBlockBatchResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("saved"), ...mutationAck, ...blockAck }),
  Schema.Struct({ ...SpaceMutationConflict.fields, ...blockAck }),
]);
export type SpaceApplyBlockBatchResult = typeof SpaceApplyBlockBatchResult.Type;

export const SpacePageRevisionGuard = Schema.Struct({
  pageId: SpacePageId,
  revision: NonNegativeInt,
});
export type SpacePageRevisionGuard = typeof SpacePageRevisionGuard.Type;
export const SpaceRootRevisionGuard = Schema.Struct({
  spaceId: SpaceId,
  rootOrderRevision: NonNegativeInt,
});
export type SpaceRootRevisionGuard = typeof SpaceRootRevisionGuard.Type;
export const SpaceStructureGuards = Schema.Struct({
  pages: Schema.Array(SpacePageRevisionGuard),
  roots: Schema.Array(SpaceRootRevisionGuard),
});
export type SpaceStructureGuards = typeof SpaceStructureGuards.Type;
export const SpaceBlockPlacement = Schema.Struct({
  pageId: SpacePageId,
  parentId: Schema.NullOr(SpaceBlockId),
  beforeBlockId: Schema.NullOr(SpaceBlockId),
});
export type SpaceBlockPlacement = typeof SpaceBlockPlacement.Type;
export const SpacePageDestination = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("root"),
    spaceId: SpaceId,
    beforePageId: Schema.NullOr(SpacePageId),
  }),
  Schema.Struct({ kind: Schema.Literal("child"), placement: SpaceBlockPlacement }),
]);
export type SpacePageDestination = typeof SpacePageDestination.Type;
export const SpaceCreateChildPageInput = Schema.Struct({
  ...mutationInput,
  title: Schema.String,
  placement: SpaceBlockPlacement,
  guards: SpaceStructureGuards,
});
export type SpaceCreateChildPageInput = typeof SpaceCreateChildPageInput.Type;
export const SpaceMovePageInput = Schema.Struct({
  ...mutationInput,
  pageId: SpacePageId,
  destination: SpacePageDestination,
  guards: SpaceStructureGuards,
});
export type SpaceMovePageInput = typeof SpaceMovePageInput.Type;
export const SpaceRecoveryOperation = Schema.Literals(["trash", "restore", "permanentlyDelete"]);
export type SpaceRecoveryOperation = typeof SpaceRecoveryOperation.Type;
export const SpaceInspectStructureInput = Schema.Struct({
  recovery: Schema.optionalKey(SpaceRecoveryOperation),
  environmentId: EnvironmentId,
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("page"), pageId: SpacePageId }),
    Schema.Struct({
      kind: Schema.Literal("blocks"),
      pageId: SpacePageId,
      blockIds: Schema.Array(SpaceBlockId),
    }),
  ]),
  destination: Schema.optionalKey(SpacePageDestination),
});
export type SpaceInspectStructureInput = typeof SpaceInspectStructureInput.Type;
export const SpaceInspectStructureResult = Schema.Struct({
  recovery: Schema.optionalKey(
    Schema.Struct({ operation: SpaceRecoveryOperation, pageIds: Schema.Array(SpacePageId) }),
  ),
  catalogRevision: NonNegativeInt,
  guards: SpaceStructureGuards,
  pages: Schema.Array(SpacePageSummary),
  blockIds: Schema.Array(SpaceBlockId),
});
export type SpaceInspectStructureResult = typeof SpaceInspectStructureResult.Type;
export const SpaceStructureConflict = Schema.Struct({
  status: Schema.Literal("conflict"),
  ...mutationAck,
  current: Schema.Struct({
    catalogRevision: NonNegativeInt,
    defaultSpaceId: SpaceId,
    pages: Schema.Array(SpacePageRevisionGuard).check(Schema.isMaxLength(100)),
    roots: Schema.Array(SpaceRootRevisionGuard).check(Schema.isMaxLength(100)),
  }),
});
export type SpaceStructureConflict = typeof SpaceStructureConflict.Type;
export const SpaceCreateChildPageResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved"),
    ...mutationAck,
    page: SpacePageSummary,
    ownerBlockId: SpaceBlockId,
    changed: SpaceStructureGuards,
  }),
  SpaceStructureConflict,
]);
export type SpaceCreateChildPageResult = typeof SpaceCreateChildPageResult.Type;
export const SpaceMovePageResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved"),
    ...mutationAck,
    page: SpacePageSummary,
    ownerBlockId: Schema.NullOr(SpaceBlockId),
    changed: SpaceStructureGuards,
  }),
  SpaceStructureConflict,
]);
export type SpaceMovePageResult = typeof SpaceMovePageResult.Type;

export const SpaceMoveBlocksInput = Schema.Struct({
  ...mutationInput,
  sourcePageId: SpacePageId,
  blockIds: Schema.Array(SpaceBlockId).check(Schema.isMinLength(1)),
  destination: SpaceBlockPlacement,
  guards: SpaceStructureGuards,
});
export type SpaceMoveBlocksInput = typeof SpaceMoveBlocksInput.Type;
export const SpaceMoveBlocksResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved"),
    ...mutationAck,
    blockIds: Schema.Array(SpaceBlockId),
    changed: SpaceStructureGuards,
  }),
  SpaceStructureConflict,
]);
export type SpaceMoveBlocksResult = typeof SpaceMoveBlocksResult.Type;
export const SpaceReferenceResolveInput = Schema.Struct({
  environmentId: EnvironmentId,
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("page"), pageId: SpacePageId }),
    Schema.Struct({ kind: Schema.Literal("block"), blockId: SpaceBlockId }),
  ]),
  pageIdHint: Schema.optionalKey(SpacePageId),
  spaceIdHint: Schema.optionalKey(SpaceId),
});
export type SpaceReferenceResolveInput = typeof SpaceReferenceResolveInput.Type;
export const SpaceReferenceResolveResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("resolved"),
    page: SpacePageSummary,
    blockId: Schema.optionalKey(SpaceBlockId),
  }),
  Schema.Struct({
    status: Schema.Literal("merged"),
    page: SpacePageSummary,
    blockId: SpaceBlockId,
    requestedBlockId: SpaceBlockId,
  }),
  Schema.Struct({ status: Schema.Literal("trashed"), pageId: SpacePageId }),
  Schema.Struct({ status: Schema.Literals(["deleted", "unavailable"]) }),
]);
export type SpaceReferenceResolveResult = typeof SpaceReferenceResolveResult.Type;

export const SpacePageRecoveryInput = Schema.Struct({
  ...mutationInput,
  pageId: SpacePageId,
  guards: SpaceStructureGuards,
});
export type SpacePageRecoveryInput = typeof SpacePageRecoveryInput.Type;
export const SpacePageRecoveryResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved"),
    ...mutationAck,
    page: SpacePageSummary,
    changed: SpaceStructureGuards,
    /** Data sources whose computed values changed with this edit. */
    affectedDataSourceIds: Schema.optionalKey(Schema.Array(SpaceDataSourceId)),
  }),
  SpaceStructureConflict,
]);
export type SpacePageRecoveryResult = typeof SpacePageRecoveryResult.Type;
export const SpacePagePurgeResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved"),
    ...mutationAck,
    pageId: SpacePageId,
    deletedPageIds: Schema.Array(SpacePageId),
    changed: SpaceStructureGuards,
    /** Data sources whose computed values changed with this edit. */
    affectedDataSourceIds: Schema.optionalKey(Schema.Array(SpaceDataSourceId)),
  }),
  SpaceStructureConflict,
]);
export type SpacePagePurgeResult = typeof SpacePagePurgeResult.Type;
export const SpaceTrashListInput = SpaceListInput;
export type SpaceTrashListInput = typeof SpaceTrashListInput.Type;
export const SpaceTrashEntry = Schema.Struct({
  pageId: SpacePageId,
  spaceId: SpaceId,
  title: Schema.String,
  revision: NonNegativeInt,
  trash: SpacePageTrashStatus,
});
export type SpaceTrashEntry = typeof SpaceTrashEntry.Type;
export const SpaceTrashListResult = Schema.Struct({
  catalogRevision: NonNegativeInt,
  items: Schema.Array(SpaceTrashEntry),
  nextCursor: Schema.NullOr(SpaceCursor),
  mutationAdmission: SpaceMutationAdmission,
});
export type SpaceTrashListResult = typeof SpaceTrashListResult.Type;

export const SpaceMutationRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("trashPage"), input: SpacePageRecoveryInput }),
  Schema.Struct({ operation: Schema.Literal("restorePage"), input: SpacePageRecoveryInput }),
  Schema.Struct({
    operation: Schema.Literal("permanentlyDeletePage"),
    input: SpacePageRecoveryInput,
  }),
  Schema.Struct({ operation: Schema.Literal("moveBlocks"), input: SpaceMoveBlocksInput }),
  Schema.Struct({ operation: Schema.Literal("createChildPage"), input: SpaceCreateChildPageInput }),
  Schema.Struct({ operation: Schema.Literal("movePage"), input: SpaceMovePageInput }),
  Schema.Struct({ operation: Schema.Literal("createSpace"), input: SpaceCreateInput }),
  Schema.Struct({ operation: Schema.Literal("renameSpace"), input: SpaceRenameInput }),
  Schema.Struct({ operation: Schema.Literal("setDefaultSpace"), input: SpaceSetDefaultInput }),
  Schema.Struct({ operation: Schema.Literal("createPage"), input: SpacePageCreateInput }),
  Schema.Struct({ operation: Schema.Literal("updatePage"), input: SpacePageUpdateInput }),
  Schema.Struct({ operation: Schema.Literal("applyBlockBatch"), input: SpaceApplyBlockBatchInput }),
  Schema.Struct({ operation: Schema.Literal("unsyncBlocks"), input: SpaceUnsyncInput }),
  Schema.Struct({ operation: Schema.Literal("createDatabase"), input: SpaceDatabaseCreateInput }),
  Schema.Struct({ operation: Schema.Literal("updateDatabase"), input: SpaceDatabaseUpdateInput }),
  Schema.Struct({
    operation: Schema.Literal("createDataSource"),
    input: SpaceDataSourceCreateInput,
  }),
  Schema.Struct({
    operation: Schema.Literal("updateDataSource"),
    input: SpaceDataSourceUpdateInput,
  }),
  Schema.Struct({
    operation: Schema.Literal("deleteDataSource"),
    input: SpaceDataSourceDeleteInput,
  }),
  Schema.Struct({ operation: Schema.Literal("updateSchema"), input: SpaceSchemaUpdateInput }),
  Schema.Struct({ operation: Schema.Literal("createView"), input: SpaceViewCreateInput }),
  Schema.Struct({ operation: Schema.Literal("updateView"), input: SpaceViewUpdateInput }),
  Schema.Struct({ operation: Schema.Literal("deleteView"), input: SpaceViewDeleteInput }),
  Schema.Struct({ operation: Schema.Literal("createRows"), input: SpaceRowsCreateInput }),
  Schema.Struct({ operation: Schema.Literal("updateRows"), input: SpaceRowsUpdateInput }),
  Schema.Struct({ operation: Schema.Literal("moveRows"), input: SpaceRowsMoveInput }),
]);
export type SpaceMutationRequest = typeof SpaceMutationRequest.Type;
export const SpaceMutationReceipt = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("trashPage"), result: SpacePageRecoveryResult }),
  Schema.Struct({ operation: Schema.Literal("restorePage"), result: SpacePageRecoveryResult }),
  Schema.Struct({
    operation: Schema.Literal("permanentlyDeletePage"),
    result: SpacePagePurgeResult,
  }),
  Schema.Struct({ operation: Schema.Literal("moveBlocks"), result: SpaceMoveBlocksResult }),
  Schema.Struct({
    operation: Schema.Literal("createChildPage"),
    result: SpaceCreateChildPageResult,
  }),
  Schema.Struct({ operation: Schema.Literal("movePage"), result: SpaceMovePageResult }),
  Schema.Struct({ operation: Schema.Literal("createSpace"), result: SpaceCreateResult }),
  Schema.Struct({ operation: Schema.Literal("renameSpace"), result: SpaceRenameResult }),
  Schema.Struct({ operation: Schema.Literal("setDefaultSpace"), result: SpaceSetDefaultResult }),
  Schema.Struct({ operation: Schema.Literal("createPage"), result: SpacePageCreateResult }),
  Schema.Struct({ operation: Schema.Literal("updatePage"), result: SpacePageUpdateResult }),
  Schema.Struct({
    operation: Schema.Literal("applyBlockBatch"),
    result: SpaceApplyBlockBatchResult,
  }),
  Schema.Struct({ operation: Schema.Literal("unsyncBlocks"), result: SpaceUnsyncResult }),
  Schema.Struct({ operation: Schema.Literal("createDatabase"), result: SpaceDatabaseCreateResult }),
  Schema.Struct({ operation: Schema.Literal("updateDatabase"), result: SpaceDatabaseUpdateResult }),
  Schema.Struct({
    operation: Schema.Literal("createDataSource"),
    result: SpaceDataSourceCreateResult,
  }),
  Schema.Struct({
    operation: Schema.Literal("updateDataSource"),
    result: SpaceDataSourceUpdateResult,
  }),
  Schema.Struct({
    operation: Schema.Literal("deleteDataSource"),
    result: SpaceDataSourceDeleteResult,
  }),
  Schema.Struct({ operation: Schema.Literal("updateSchema"), result: SpaceSchemaUpdateResult }),
  Schema.Struct({ operation: Schema.Literal("createView"), result: SpaceViewCreateResult }),
  Schema.Struct({ operation: Schema.Literal("updateView"), result: SpaceViewUpdateResult }),
  Schema.Struct({ operation: Schema.Literal("deleteView"), result: SpaceViewDeleteResult }),
  Schema.Struct({ operation: Schema.Literal("createRows"), result: SpaceRowsCreateResult }),
  Schema.Struct({ operation: Schema.Literal("updateRows"), result: SpaceRowsUpdateResult }),
  Schema.Struct({ operation: Schema.Literal("moveRows"), result: SpaceRowsMoveResult }),
]);
export type SpaceMutationReceipt = typeof SpaceMutationReceipt.Type;
export const SpaceReceiptLookupInput = Schema.Struct({ request: SpaceMutationRequest });
export type SpaceReceiptLookupInput = typeof SpaceReceiptLookupInput.Type;
export const SpaceReceiptLookupResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("found"), receipt: SpaceMutationReceipt }),
  Schema.Struct({ status: Schema.Literal("absent") }),
  Schema.Struct({ status: Schema.Literal("unknown") }),
]);
export type SpaceReceiptLookupResult = typeof SpaceReceiptLookupResult.Type;

export * from "./spacesCapability.ts";
export * from "./spacesErrors.ts";
export * from "./spacesPageChanges.ts";
