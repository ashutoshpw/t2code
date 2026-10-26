import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { EnvironmentId, IsoDateTime, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

// Provisional editor values; order tokens and persistence are owned by the future service.
const StableId = Schema.String.check(Schema.isMinLength(1));
export const SpaceId = StableId.pipe(Schema.brand("SpaceId"));
export type SpaceId = typeof SpaceId.Type;
export const SpacePageId = StableId.pipe(Schema.brand("SpacePageId"));
export type SpacePageId = typeof SpacePageId.Type;
export const SpaceBlockId = StableId.pipe(Schema.brand("SpaceBlockId"));
export type SpaceBlockId = typeof SpaceBlockId.Type;
export const SpaceAssetId = StableId.pipe(Schema.brand("SpaceAssetId"));
export type SpaceAssetId = typeof SpaceAssetId.Type;

export const SpacePageTarget = Schema.Struct({ environmentId: EnvironmentId, pageId: SpacePageId });
export type SpacePageTarget = typeof SpacePageTarget.Type;
export const SpaceBlockTarget = Schema.Struct({
  environmentId: EnvironmentId,
  pageId: SpacePageId,
  blockId: SpaceBlockId,
});
export type SpaceBlockTarget = typeof SpaceBlockTarget.Type;

export const SpaceKnownMark = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["bold", "italic", "strike", "code"]),
    version: Schema.Literal(1),
  }),
  Schema.Struct({ type: Schema.Literal("link"), version: Schema.Literal(1), href: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("page_mention"),
    version: Schema.Literal(1),
    target: SpacePageTarget,
  }),
  Schema.Struct({
    type: Schema.Literal("block_mention"),
    version: Schema.Literal(1),
    target: SpaceBlockTarget,
  }),
]);
export type SpaceKnownMark = typeof SpaceKnownMark.Type;

export const SpaceMark = Schema.StructWithRest(
  Schema.Struct({ type: StableId, version: PositiveInt }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type SpaceMark = typeof SpaceMark.Type;
export const SpaceRichRun = Schema.StructWithRest(
  Schema.Struct({ text: Schema.String, marks: Schema.Array(SpaceMark) }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type SpaceRichRun = typeof SpaceRichRun.Type;
export const SpaceRichText = Schema.Array(SpaceRichRun);
export type SpaceRichText = typeof SpaceRichText.Type;

const blockBase = {
  id: SpaceBlockId,
  parentId: Schema.NullOr(SpaceBlockId),
  order: StableId,
  version: Schema.Literal(1),
};
const textContent = { runs: SpaceRichText };
export const SpaceKnownBlock = Schema.Union([
  Schema.Struct({
    ...blockBase,
    type: Schema.Literals(["paragraph", "quote", "bulleted_item", "numbered_item"]),
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
export const SpaceReceiptEpoch = StableId.pipe(Schema.brand("SpaceReceiptEpoch"));
export type SpaceReceiptEpoch = typeof SpaceReceiptEpoch.Type;
export const SpaceMutationId = StableId.pipe(Schema.brand("SpaceMutationId"));
export type SpaceMutationId = typeof SpaceMutationId.Type;
export const SpaceCursor = StableId.pipe(Schema.brand("SpaceCursor"));
export type SpaceCursor = typeof SpaceCursor.Type;

export const SpaceMutationAdmission = Schema.Struct({
  epoch: SpaceReceiptEpoch,
  acceptsUntil: IsoDateTime,
  retainUntil: IsoDateTime,
});
export type SpaceMutationAdmission = typeof SpaceMutationAdmission.Type;

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
export const SpacePageSummary = Schema.Struct({
  id: SpacePageId,
  spaceId: SpaceId,
  title: Schema.String,
  revision: NonNegativeInt,
  rootOrder: Schema.NullOr(StableId),
  location: Schema.optionalKey(SpacePageLocation),
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

const mutationAck = { mutationId: SpaceMutationId, receiptEpoch: SpaceReceiptEpoch };
const mutationInput = { environmentId: EnvironmentId, ...mutationAck };
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

export const SpaceListInput = Schema.Struct({
  environmentId: EnvironmentId,
  cursor: Schema.optionalKey(SpaceCursor),
  limit: Schema.optionalKey(PositiveInt),
});
export type SpaceListInput = typeof SpaceListInput.Type;
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
});
export type SpacePageUpdateInput = typeof SpacePageUpdateInput.Type;
export const SpacePageUpdateResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("saved"), ...mutationAck, page: SpacePageSummary }),
  SpaceMutationConflict,
]);
export type SpacePageUpdateResult = typeof SpacePageUpdateResult.Type;
export const SpaceApplyBlockBatchInput = Schema.Struct({
  ...mutationInput,
  pageId: SpacePageId,
  baseRevision: NonNegativeInt,
  generation: NonNegativeInt,
  mutations: Schema.Array(SpaceBlockMutation),
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
export const SpaceInspectStructureInput = Schema.Struct({
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

export const SpaceMutationRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("createChildPage"), input: SpaceCreateChildPageInput }),
  Schema.Struct({ operation: Schema.Literal("movePage"), input: SpaceMovePageInput }),
  Schema.Struct({ operation: Schema.Literal("createSpace"), input: SpaceCreateInput }),
  Schema.Struct({ operation: Schema.Literal("renameSpace"), input: SpaceRenameInput }),
  Schema.Struct({ operation: Schema.Literal("setDefaultSpace"), input: SpaceSetDefaultInput }),
  Schema.Struct({ operation: Schema.Literal("createPage"), input: SpacePageCreateInput }),
  Schema.Struct({ operation: Schema.Literal("updatePage"), input: SpacePageUpdateInput }),
  Schema.Struct({ operation: Schema.Literal("applyBlockBatch"), input: SpaceApplyBlockBatchInput }),
]);
export type SpaceMutationRequest = typeof SpaceMutationRequest.Type;
export const SpaceMutationReceipt = Schema.Union([
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

export const SpaceHistoryLimits = Schema.Struct({
  maxRevisionsPerPage: PositiveInt,
  retentionMs: PositiveInt,
  maxDeltaBytes: PositiveInt,
  maxPageBytes: PositiveInt,
  maxEnvironmentBytes: PositiveInt,
  cleanupBatchRows: PositiveInt,
  cleanupBatchBytes: PositiveInt,
});
export type SpaceHistoryLimits = typeof SpaceHistoryLimits.Type;

// These describe advertised service policy; replay decoding must not freeze today's maxima.
export const SpaceLimits = Schema.Struct({
  history: Schema.optionalKey(SpaceHistoryLimits),
  maxListRows: PositiveInt,
  maxListResponseBytes: PositiveInt,
  maxBlockWindowBlocks: PositiveInt,
  maxBlockWindowResponseBytes: PositiveInt,
  maxMutationNodes: PositiveInt,
  maxMutationBytes: PositiveInt,
  maxBlockBytes: PositiveInt,
  maxDepth: PositiveInt,
  maxPageBlocks: PositiveInt,
  maxPageBytes: PositiveInt,
  maxIdBytes: PositiveInt,
  maxTitleBytes: PositiveInt,
  maxOrderBytes: PositiveInt,
  maxCursorBytes: PositiveInt,
  maxReceiptBytes: PositiveInt,
  maxReceiptRows: PositiveInt,
  maxReceiptStorageBytes: PositiveInt,
  maxEpochRows: PositiveInt,
  receiptRetentionMs: PositiveInt,
  cleanupBatchRows: PositiveInt,
});
export type SpaceLimits = typeof SpaceLimits.Type;
export const SpaceCapability = Schema.Struct({ version: PositiveInt, limits: SpaceLimits });
export type SpaceCapability = typeof SpaceCapability.Type;

export class SpacesDisabledError extends Schema.TaggedError<SpacesDisabledError>()(
  "SpacesDisabledError",
  {},
) {
  override get message(): string {
    return "Spaces is disabled.";
  }
}
export class SpacesUnavailableError extends Schema.TaggedError<SpacesUnavailableError>()(
  "SpacesUnavailableError",
  { stage: Schema.Literals(["initializing", "storage", "settings", "capacity"]) },
) {
  override get message(): string {
    return "Spaces is unavailable.";
  }
}
export class SpaceEnvironmentMismatchError extends Schema.TaggedError<SpaceEnvironmentMismatchError>()(
  "SpaceEnvironmentMismatchError",
  { environmentId: EnvironmentId },
) {
  override get message(): string {
    return "The Spaces environment does not match.";
  }
}
export class SpaceNotFoundError extends Schema.TaggedError<SpaceNotFoundError>()(
  "SpaceNotFoundError",
  { entity: Schema.Literals(["space", "page", "block"]), id: StableId },
) {
  override get message(): string {
    return "The Spaces item was not found.";
  }
}
export class SpaceValidationError extends Schema.TaggedError<SpaceValidationError>()(
  "SpaceValidationError",
  {
    reason: Schema.Literals([
      "invalid_cursor",
      "invalid_order",
      "duplicate_id",
      "invalid_parent",
      "cycle",
      "unsupported_block",
      "invalid_merge",
      "invalid_input",
    ]),
  },
) {
  override get message(): string {
    return "The Spaces request is invalid.";
  }
}
export class SpaceLimitExceededError extends Schema.TaggedError<SpaceLimitExceededError>()(
  "SpaceLimitExceededError",
  {
    limit: Schema.Literals([
      ...Struct.keys(SpaceLimits.fields).filter((key) => key !== "history"),
      "history.maxDeltaBytes",
      "history.maxPageBytes",
      "history.maxEnvironmentBytes",
    ]),
    actual: NonNegativeInt,
    maximum: PositiveInt,
  },
) {
  override get message(): string {
    return `The Spaces request exceeds ${this.limit}.`;
  }
}
export class SpaceMutationIdMismatchError extends Schema.TaggedError<SpaceMutationIdMismatchError>()(
  "SpaceMutationIdMismatchError",
  { mutationId: SpaceMutationId },
) {
  override get message(): string {
    return "The Spaces mutation ID belongs to a different request.";
  }
}
export class SpaceMutationAdmissionError extends Schema.TaggedError<SpaceMutationAdmissionError>()(
  "SpaceMutationAdmissionError",
  { receiptEpoch: SpaceReceiptEpoch },
) {
  override get message(): string {
    return "The Spaces mutation admission has expired or is unknown.";
  }
}
export class SpaceCursorStaleError extends Schema.TaggedError<SpaceCursorStaleError>()(
  "SpaceCursorStaleError",
  { revision: NonNegativeInt },
) {
  override get message(): string {
    return "The Spaces cursor is stale.";
  }
}
export const SpaceServiceError = Schema.Union([
  SpacesDisabledError,
  SpacesUnavailableError,
  SpaceEnvironmentMismatchError,
  SpaceNotFoundError,
  SpaceValidationError,
  SpaceLimitExceededError,
  SpaceMutationIdMismatchError,
  SpaceMutationAdmissionError,
  SpaceCursorStaleError,
]);
export type SpaceServiceError = typeof SpaceServiceError.Type;
