import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import type * as SqlError from "effect/sql/SqlError";
import * as Schema from "effect/Schema";
import * as Catalog from "../assets/Catalog.ts";
import * as Upload from "../assets/Upload.ts";
import { byteLength, canonical, ensureLimit } from "../CorePolicy.ts";
import * as PageStore from "../PageStore.ts";
import * as SpacesSql from "../SpacesSql.ts";

export interface SpaceRow {
  readonly space_id: C.SpaceId;
  readonly title: string;
  readonly is_default: number;
  readonly revision: number;
  readonly root_order_revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}
export type PageRow = PageStore.PageRow;
export type PageListCandidate = { readonly [K in keyof PageRow]: PageRow[K] | null } & {
  readonly list_order: string;
  readonly list_id: string;
};
export const spaceSummary = (row: SpaceRow): C.SpaceSummary => ({
  id: row.space_id,
  title: row.title,
  isDefault: row.is_default === 1,
  revision: row.revision,
  rootOrderRevision: row.root_order_revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
export const pageSummary = PageStore.summary;
export const strict = { onExcessProperty: "error" } as const;
export const decodeSearch = Schema.decodeUnknownEffect(C.SpaceSearchInput, strict);
export const decodeTrashList = Schema.decodeUnknownEffect(C.SpaceTrashListInput, strict);
export const decodeRecoveryResult = Schema.decodeUnknownSync(C.SpacePageRecoveryResult, strict);
export const decodePurgeResult = Schema.decodeUnknownSync(C.SpacePagePurgeResult, strict);
export const decodeAssetCreate = Schema.decodeUnknownEffect(C.SpaceAssetUploadCreateInput, strict);
export const decodeAssetUpload = Schema.decodeUnknownEffect(C.SpaceAssetUploadInput, strict);
export const decodeAssetGet = Schema.decodeUnknownEffect(C.SpaceAssetGetInput, strict);
type AssetOperationError =
  | Catalog.AssetCatalogError
  | Upload.AssetUploadError
  | import("../assets/Files.ts").AssetFileError
  | SqlError.SqlError
  | C.SpaceServiceError;
const mapAssetError = (error: AssetOperationError): C.SpaceServiceError => {
  switch (error._tag) {
    case "AssetCatalogError":
    case "AssetUploadError":
    case "AssetFileError":
      return new C.SpaceAssetError({ reason: error.reason });
    case "SqlError":
      return new C.SpacesUnavailableError({ stage: "storage" });
    default:
      return error;
  }
};
export const assetErrors = <A, E extends AssetOperationError, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.mapError(effect, mapAssetError);
export const metadata = (row: Catalog.UploadRow): C.SpaceAssetMetadata => ({
  assetId: C.SpaceAssetId.make(row.asset_id),
  digest: row.digest!,
  byteSize: row.expected_bytes,
  mimeType: row.mime_type,
  name: row.name,
  ...(row.width !== null && row.height !== null
    ? { imageDimensions: { width: row.width, height: row.height } }
    : {}),
});
export const claimFrom = (row: Catalog.UploadRow) =>
  row.attempt_id === null ? null : { ...row, attempt_id: row.attempt_id };
export const decodeList = Schema.decodeUnknownEffect(C.SpaceListInput, strict);
export const decodePages = Schema.decodeUnknownEffect(C.SpacePageListInput, strict);
export const decodeGet = Schema.decodeUnknownEffect(C.SpacePageGetInput, strict);
export const decodeReference = Schema.decodeUnknownEffect(C.SpaceReferenceResolveInput, strict);
export const decodeMoveBlocksResult = Schema.decodeUnknownSync(C.SpaceMoveBlocksResult, strict);
export const decodeInspect = Schema.decodeUnknownEffect(C.SpaceInspectStructureInput, strict);
export const decodeBlocks = Schema.decodeUnknownEffect(C.SpaceReadBlocksInput, strict);
export const decodeRequest = Schema.decodeUnknownEffect(C.SpaceMutationRequest, strict);
export const decodeLookup = Schema.decodeUnknownEffect(C.SpaceReceiptLookupInput, strict);
export const decodeReceipt = Schema.decodeUnknownSync(C.SpaceMutationReceipt, strict);
export const decodeCreateResult = Schema.decodeUnknownSync(C.SpaceCreateResult, strict);
export const decodeRenameResult = Schema.decodeUnknownSync(C.SpaceRenameResult, strict);
export const decodeDefaultResult = Schema.decodeUnknownSync(C.SpaceSetDefaultResult, strict);
export const decodePageCreateResult = Schema.decodeUnknownSync(C.SpacePageCreateResult, strict);
export const decodePageUpdateResult = Schema.decodeUnknownSync(C.SpacePageUpdateResult, strict);
export const decodeApplyResult = Schema.decodeUnknownSync(C.SpaceApplyBlockBatchResult, strict);
export const decodeCreateChildResult = Schema.decodeUnknownSync(
  C.SpaceCreateChildPageResult,
  strict,
);
export const decodeMovePageResult = Schema.decodeUnknownSync(C.SpaceMovePageResult, strict);
export const isServiceError = Schema.is(C.SpaceServiceError);
export const isSearchUnavailable = Schema.is(C.SpaceSearchUnavailableError);
const Cursor = Schema.Struct({
  environmentId: EnvironmentId,
  operation: Schema.String,
  filter: Schema.String,
  revision: Schema.Int,
  key: Schema.String,
  id: Schema.String,
});
const decodeCursor = Schema.decodeUnknownSync(Cursor, strict);

const parseRaw = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

export const validateRaw = Effect.fn("SpacesService.validateRaw")((raw: unknown) =>
  Effect.try({
    try: () => parseRaw(canonical(raw)),
    catch: (cause) =>
      isServiceError(cause) ? cause : new C.SpaceValidationError({ reason: "invalid_input" }),
  }),
);

export const cursorFor = Effect.fnUntraced(function* (
  environmentId: EnvironmentId,
  operation: string,
  filter: string,
  revision: number,
  key: string,
  id: string,
) {
  const cursor = Buffer.from(
    canonical({ environmentId, operation, filter, revision, key, id }),
  ).toString("base64url");
  yield* ensureLimit("maxCursorBytes", byteLength(cursor));
  return C.SpaceCursor.make(cursor);
});
export const cursorFrom = Effect.fnUntraced(function* (
  cursor: C.SpaceCursor | undefined,
  environmentId: EnvironmentId,
  operation: string,
  filter: string,
  revision: number,
  filterRevision = false,
) {
  if (cursor === undefined) return undefined;
  yield* ensureLimit("maxCursorBytes", byteLength(cursor));
  const decoded = yield* Effect.try({
    try: () => decodeCursor(parseRaw(Buffer.from(cursor, "base64url").toString("utf8"))),
    catch: () => new C.SpaceValidationError({ reason: "invalid_cursor" }),
  });
  if (decoded.environmentId !== environmentId || decoded.operation !== operation)
    return yield* new C.SpaceValidationError({ reason: "invalid_cursor" });
  if (decoded.filter !== filter) {
    if (
      filterRevision &&
      /^(0|[1-9]\d*)$/.test(decoded.filter) &&
      Number.isSafeInteger(Number(decoded.filter))
    )
      return yield* new C.SpaceCursorStaleError({ revision });
    return yield* new C.SpaceValidationError({ reason: "invalid_cursor" });
  }
  if (decoded.revision !== revision) return yield* new C.SpaceCursorStaleError({ revision });
  return decoded;
});
const decodeAssetCursorIds = Schema.decodeUnknownSync(Schema.Tuple([Schema.String, Schema.String]));
export const decodeAssetCursor = (cursor: typeof Cursor.Type) =>
  Effect.try({
    try: () => {
      const ids = decodeAssetCursorIds(parseRaw(cursor.id));
      if (!Number.isSafeInteger(Number(cursor.key)) || String(Number(cursor.key)) !== cursor.key)
        throw new Error();
      return ids;
    },
    catch: () => new C.SpaceValidationError({ reason: "invalid_cursor" }),
  });
export const checkIds = Effect.fnUntraced(function* (input: object) {
  for (const [key, value] of Object.entries(input)) {
    if (key.endsWith("Id") || key === "receiptEpoch")
      yield* ensureLimit("maxIdBytes", byteLength(value));
  }
});

export const needsWrite = Symbol("needsWrite");

export const assetMetadata = (row: {
  readonly asset_id: string;
  readonly digest: string;
  readonly byte_size: number;
  readonly mime_type: C.SpaceAssetMetadata["mimeType"];
  readonly name: string;
  readonly width: number | null;
  readonly height: number | null;
}) => ({
  assetId: C.SpaceAssetId.make(row.asset_id),
  digest: row.digest,
  byteSize: row.byte_size,
  mimeType: row.mime_type,
  name: row.name,
  ...(row.width !== null && row.height !== null
    ? { imageDimensions: { width: row.width, height: row.height } }
    : {}),
});

export const getSpace = Effect.fn("SpacesService.space")(function* (id: C.SpaceId) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<SpaceRow>`SELECT * FROM spaces WHERE space_id = ${id}`;
  if (!row) return yield* new C.SpaceNotFoundError({ entity: "space", id });
  return row;
});
export const getPageRow = PageStore.read;
export const defaultSpace = Effect.fn("SpacesService.default")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<SpaceRow>`SELECT * FROM spaces WHERE is_default = 1`;
  if (!row) return yield* new C.SpacesUnavailableError({ stage: "storage" });
  return row;
});
