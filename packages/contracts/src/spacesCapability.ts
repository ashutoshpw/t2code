import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { SpaceAssetId, SpaceCursor, SpaceId, SpacePageId, StableId } from "./spacesCore.ts";
import { SpaceDatabaseLimits } from "./spacesDatabases.ts";

export const SpaceListInput = Schema.Struct({
  environmentId: EnvironmentId,
  cursor: Schema.optionalKey(SpaceCursor),
  limit: Schema.optionalKey(PositiveInt),
});
export type SpaceListInput = typeof SpaceListInput.Type;

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

export const SpaceSearchLimits = Schema.Struct({
  maxQueryBytes: PositiveInt,
  maxTerms: PositiveInt,
  maxRows: PositiveInt,
  maxResponseBytes: PositiveInt,
  maxCandidates: PositiveInt,
  maxCandidateBytes: PositiveInt,
  maxSnippetBytes: PositiveInt,
  backfillRows: PositiveInt,
  backfillBytes: PositiveInt,
});
export type SpaceSearchLimits = typeof SpaceSearchLimits.Type;

// These describe advertised service policy; replay decoding must not freeze today's maxima.
export const SpaceAssetLimits = Schema.Struct({
  maxImageBytes: PositiveInt,
  maxPdfBytes: PositiveInt,
  maxVideoBytes: PositiveInt,
  maxImagePixels: PositiveInt,
  maxHeaderBytes: PositiveInt,
  maxEnvironmentBytes: PositiveInt,
  maxPendingPerCaller: PositiveInt,
  maxPendingUploads: PositiveInt,
  maxActiveUploads: PositiveInt,
  uploadTtlMs: PositiveInt,
  recoveryBatchRows: PositiveInt,
  recoveryBatchBytes: PositiveInt,
});
export type SpaceAssetLimits = typeof SpaceAssetLimits.Type;
export const SpaceAssetUploadId = StableId.pipe(Schema.brand("SpaceAssetUploadId"));
export type SpaceAssetUploadId = typeof SpaceAssetUploadId.Type;
export const SpaceAssetMimeType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "video/mp4",
  "video/webm",
]);
export const SpaceAssetUploadCreateInput = Schema.Struct({
  environmentId: EnvironmentId,
  requestId: StableId,
  expectedBytes: PositiveInt,
  mimeType: SpaceAssetMimeType,
  mediaKind: Schema.Literals(["image", "pdf", "video"]),
  name: Schema.String,
});
export type SpaceAssetUploadCreateInput = typeof SpaceAssetUploadCreateInput.Type;
export const SpaceAssetUploadInput = Schema.Struct({
  environmentId: EnvironmentId,
  uploadId: SpaceAssetUploadId,
});
export type SpaceAssetUploadInput = typeof SpaceAssetUploadInput.Type;
export const SpaceAssetGetInput = Schema.Struct({
  environmentId: EnvironmentId,
  assetId: SpaceAssetId,
});
export type SpaceAssetGetInput = typeof SpaceAssetGetInput.Type;
export const SpaceAssetMetadata = Schema.Struct({
  assetId: SpaceAssetId,
  digest: Schema.String,
  byteSize: PositiveInt,
  mimeType: SpaceAssetMimeType,
  name: Schema.String,
  imageDimensions: Schema.optionalKey(Schema.Struct({ width: PositiveInt, height: PositiveInt })),
});
export type SpaceAssetMetadata = typeof SpaceAssetMetadata.Type;
export const SpaceAssetListInput = Schema.Struct({
  ...SpaceListInput.fields,
  mediaType: Schema.optionalKey(Schema.Literals(["image", "pdf", "video"])),
});
export type SpaceAssetListInput = typeof SpaceAssetListInput.Type;
export const SpaceAssetListResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      assetId: SpaceAssetId,
      name: Schema.String,
      mimeType: SpaceAssetMimeType,
      byteSize: PositiveInt,
      createdAt: IsoDateTime,
      pageId: SpacePageId,
      spaceId: SpaceId,
    }),
  ),
  catalogRevision: NonNegativeInt,
  nextCursor: Schema.NullOr(SpaceCursor),
});
export type SpaceAssetListResult = typeof SpaceAssetListResult.Type;
export const SpaceAssetUploadCreateResult = Schema.Struct({
  uploadId: SpaceAssetUploadId,
  assetId: SpaceAssetId,
  expiresAt: NonNegativeInt,
  relativeUrl: Schema.String,
});
export type SpaceAssetUploadCreateResult = typeof SpaceAssetUploadCreateResult.Type;
export const SpaceAssetUploadStatus = Schema.Struct({
  uploadId: SpaceAssetUploadId,
  assetId: SpaceAssetId,
  expiresAt: NonNegativeInt,
  state: Schema.Literals(["reserved", "receiving", "verified", "ready", "expired"]),
  recoveryPending: Schema.Boolean,
});
export type SpaceAssetUploadStatus = typeof SpaceAssetUploadStatus.Type;

export const SpaceLimits = Schema.Struct({
  assets: Schema.optionalKey(SpaceAssetLimits),
  history: Schema.optionalKey(SpaceHistoryLimits),
  search: Schema.optionalKey(SpaceSearchLimits),
  databases: Schema.optionalKey(SpaceDatabaseLimits),
  maxReferenceHops: Schema.optionalKey(PositiveInt),
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
export const SpacesAssetReconciliationStatus = Schema.Struct({
  currentPending: Schema.Boolean,
  historyPending: Schema.Boolean,
  catalogPending: Schema.Boolean,
  inventoryPending: Schema.Boolean,
  unresolved: Schema.Boolean,
  gcEnabled: Schema.Boolean,
  gcPending: Schema.optionalKey(Schema.Boolean),
});
export const SpaceCapability = Schema.Struct({
  version: PositiveInt,
  limits: SpaceLimits,
  assetRecoveryPending: Schema.optionalKey(Schema.Boolean),
  assetReconciliation: Schema.optionalKey(SpacesAssetReconciliationStatus),
  // Flags describe implemented methods, independently of permissions and index readiness.
  features: Schema.optionalKey(
    Schema.Struct({
      pins: Schema.optionalKey(Schema.Literal(true)),
      recents: Schema.optionalKey(Schema.Literal(true)),
      assetList: Schema.optionalKey(Schema.Literal(true)),
      allPages: Schema.optionalKey(Schema.Literal(true)),
      blockMoves: Schema.optionalKey(Schema.Literal(true)),
      referenceResolution: Schema.optionalKey(Schema.Literal(true)),
      recovery: Schema.optionalKey(Schema.Literal(true)),
      search: Schema.optionalKey(Schema.Literal(true)),
      contextCapture: Schema.optionalKey(Schema.Literal(true)),
      assets: Schema.optionalKey(Schema.Literal(true)),
      databases: Schema.optionalKey(Schema.Literal(true)),
      databaseChanges: Schema.optionalKey(Schema.Literal(true)),
      pageChanges: Schema.optionalKey(Schema.Literal(true)),
      tabs: Schema.optionalKey(Schema.Literal(true)),
      syncedBlocks: Schema.optionalKey(Schema.Literal(true)),
      comments: Schema.optionalKey(Schema.Literal(true)),
      databaseHideTitle: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
});
export type SpaceCapability = typeof SpaceCapability.Type;
