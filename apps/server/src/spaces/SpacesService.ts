// @effect-diagnostics nodeBuiltinImport:off -- stable IDs are allocated by the platform cryptographic generator.
import * as NodeCrypto from "node:crypto";

import { EnvironmentId, type SpacesStorageStatus } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type * as SqlError from "effect/sql/SqlError";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { openMediaFile } from "../assets/MediaFile.ts";
import * as Catalog from "./assets/Catalog.ts";
import * as Upload from "./assets/Upload.ts";
import * as Tokens from "./assets/Tokens.ts";
import * as AssetReferences from "./assets/References.ts";
import * as Reconciliation from "./assets/Reconciliation.ts";
import * as Inventory from "./assets/Inventory.ts";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BlockStore from "./BlockStore.ts";
import {
  byteLength,
  canonical,
  checkLimit,
  limits,
  searchLimits,
  checkSearchLimit,
} from "./CorePolicy.ts";
import * as Receipts from "./Receipts.ts";
import * as RevisionStore from "./RevisionStore.ts";
import * as PageStore from "./PageStore.ts";
import * as PageStructure from "./PageStructure.ts";
import * as PageRecovery from "./PageRecovery.ts";
import * as ReferenceStore from "./ReferenceStore.ts";
import * as SpacesSql from "./SpacesSql.ts";
import * as SearchStore from "./SearchStore.ts";
import * as Sqlite from "./Sqlite.ts";

export class SpacesService extends Context.Service<
  SpacesService,
  {
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
    readonly getAssetMetadata: (
      input: unknown,
    ) => Effect.Effect<C.SpaceAssetMetadata, C.SpaceServiceError>;
    readonly resolveAssetFile: (input: unknown) => Effect.Effect<
      {
        readonly path: string;
        readonly digest: string;
        readonly byteSize: number;
        readonly name: string;
        readonly mimeType: C.SpaceAssetMetadata["mimeType"];
        readonly file: NonNullable<Effect.Success<ReturnType<typeof openMediaFile>>>;
      },
      C.SpaceServiceError,
      Scope.Scope
    >;
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
    readonly lookupMutationReceipt: (
      input: unknown,
    ) => Effect.Effect<C.SpaceReceiptLookupResult, C.SpaceServiceError>;
  }
>()("@t2code/cli/spaces/SpacesService") {}

interface SpaceRow {
  readonly space_id: C.SpaceId;
  readonly title: string;
  readonly is_default: number;
  readonly revision: number;
  readonly root_order_revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}
type PageRow = PageStore.PageRow;
type PageListCandidate = { readonly [K in keyof PageRow]: PageRow[K] | null } & {
  readonly list_order: string;
  readonly list_id: string;
};
const spaceSummary = (row: SpaceRow): C.SpaceSummary => ({
  id: row.space_id,
  title: row.title,
  isDefault: row.is_default === 1,
  revision: row.revision,
  rootOrderRevision: row.root_order_revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const pageSummary = PageStore.summary;
const pagePreimage = PageStore.preimage;
const strict = { onExcessProperty: "error" } as const;
const decodeSearch = Schema.decodeUnknownEffect(C.SpaceSearchInput, strict);
const decodeTrashList = Schema.decodeUnknownEffect(C.SpaceTrashListInput, strict);
const decodeRecoveryResult = Schema.decodeUnknownSync(C.SpacePageRecoveryResult, strict);
const decodePurgeResult = Schema.decodeUnknownSync(C.SpacePagePurgeResult, strict);
const decodeAssetCreate = Schema.decodeUnknownEffect(C.SpaceAssetUploadCreateInput, strict);
const decodeAssetUpload = Schema.decodeUnknownEffect(C.SpaceAssetUploadInput, strict);
const decodeAssetGet = Schema.decodeUnknownEffect(C.SpaceAssetGetInput, strict);
type AssetOperationError =
  | Catalog.AssetCatalogError
  | Upload.AssetUploadError
  | import("./assets/Files.ts").AssetFileError
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
const assetErrors = <A, E extends AssetOperationError, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.mapError(effect, mapAssetError);
const metadata = (row: Catalog.UploadRow): C.SpaceAssetMetadata => ({
  assetId: C.SpaceAssetId.make(row.asset_id),
  digest: row.digest!,
  byteSize: row.expected_bytes,
  mimeType: row.mime_type,
  name: row.name,
  ...(row.width !== null && row.height !== null
    ? { imageDimensions: { width: row.width, height: row.height } }
    : {}),
});
const claimFrom = (row: Catalog.UploadRow) =>
  row.attempt_id === null ? null : { ...row, attempt_id: row.attempt_id };
const decodeList = Schema.decodeUnknownEffect(C.SpaceListInput, strict);
const decodePages = Schema.decodeUnknownEffect(C.SpacePageListInput, strict);
const decodeGet = Schema.decodeUnknownEffect(C.SpacePageGetInput, strict);
const decodeReference = Schema.decodeUnknownEffect(C.SpaceReferenceResolveInput, strict);
const decodeMoveBlocksResult = Schema.decodeUnknownSync(C.SpaceMoveBlocksResult, strict);
const decodeInspect = Schema.decodeUnknownEffect(C.SpaceInspectStructureInput, strict);
const decodeBlocks = Schema.decodeUnknownEffect(C.SpaceReadBlocksInput, strict);
const decodeRequest = Schema.decodeUnknownEffect(C.SpaceMutationRequest, strict);
const decodeLookup = Schema.decodeUnknownEffect(C.SpaceReceiptLookupInput, strict);
const decodeReceipt = Schema.decodeUnknownSync(C.SpaceMutationReceipt, strict);
const decodeCreateResult = Schema.decodeUnknownSync(C.SpaceCreateResult, strict);
const decodeRenameResult = Schema.decodeUnknownSync(C.SpaceRenameResult, strict);
const decodeDefaultResult = Schema.decodeUnknownSync(C.SpaceSetDefaultResult, strict);
const decodePageCreateResult = Schema.decodeUnknownSync(C.SpacePageCreateResult, strict);
const decodePageUpdateResult = Schema.decodeUnknownSync(C.SpacePageUpdateResult, strict);
const decodeApplyResult = Schema.decodeUnknownSync(C.SpaceApplyBlockBatchResult, strict);
const decodeCreateChildResult = Schema.decodeUnknownSync(C.SpaceCreateChildPageResult, strict);
const decodeMovePageResult = Schema.decodeUnknownSync(C.SpaceMovePageResult, strict);
const isServiceError = Schema.is(C.SpaceServiceError);
const isSearchUnavailable = Schema.is(C.SpaceSearchUnavailableError);
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

const validateRaw = Effect.fn("SpacesService.validateRaw")((raw: unknown) =>
  Effect.try({
    try: () => parseRaw(canonical(raw)),
    catch: (cause) =>
      isServiceError(cause) ? cause : new C.SpaceValidationError({ reason: "invalid_input" }),
  }),
);

function cursorFor(
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
  checkLimit("maxCursorBytes", byteLength(cursor));
  return C.SpaceCursor.make(cursor);
}
function cursorFrom(
  cursor: C.SpaceCursor | undefined,
  environmentId: EnvironmentId,
  operation: string,
  filter: string,
  revision: number,
) {
  if (cursor === undefined) return undefined;
  checkLimit("maxCursorBytes", byteLength(cursor));
  let decoded: typeof Cursor.Type;
  try {
    decoded = decodeCursor(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new C.SpaceValidationError({ reason: "invalid_cursor" });
  }
  if (
    decoded.environmentId !== environmentId ||
    decoded.operation !== operation ||
    decoded.filter !== filter
  )
    throw new C.SpaceValidationError({ reason: "invalid_cursor" });
  if (decoded.revision !== revision) throw new C.SpaceCursorStaleError({ revision });
  return decoded;
}
function checkIds(input: object) {
  for (const [key, value] of Object.entries(input)) {
    if (key.endsWith("Id") || key === "receiptEpoch") checkLimit("maxIdBytes", byteLength(value));
  }
}

const make = Effect.fn("SpacesService.make")(function* (
  dbPath: string,
  directories?: { readonly assetsDir: string; readonly stagingDir: string },
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const scope = yield* Effect.scope;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const mutex = yield* Semaphore.make(1);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const assetDirectories = directories ?? {
    assetsDir: path.join(path.dirname(dbPath), "spaces", "assets"),
    stagingDir: path.join(path.dirname(dbPath), "spaces", "staging"),
  };
  const activeUploads = new Set<string>();
  const inventory = yield* Inventory.make(assetDirectories);
  const maintenanceMutex = yield* Semaphore.make(1);
  const recover = Effect.fn("SpacesService.recoverAsset")(function* (
    row: Catalog.UploadRow,
    now: number,
  ) {
    const sql = yield* SpacesSql.SpacesSql;
    const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      mutex.withPermits(1)(sql.withTransaction(effect));
    const claim = claimFrom(row);
    if (!claim) return yield* new C.SpaceAssetError({ reason: "not_ready" });
    if (row.state === "receiving") {
      const absent = yield* Upload.discardAbandonedStaging(claim, assetDirectories);
      yield* transaction(Catalog.abort(claim, absent, now));
      return;
    }
    const recovered = yield* Upload.recoverPublication(claim, assetDirectories).pipe(Effect.result);
    if (recovered._tag === "Failure") {
      if (recovered.failure.reason !== "missing_file") return yield* recovered.failure;
      const missing = yield* Upload.confirmMissingPublication(claim, assetDirectories);
      yield* transaction(Catalog.resetMissing(claim, missing, now));
      return;
    }
    yield* transaction(Catalog.finish(claim, recovered.success, now));
    const ready = claimFrom(yield* Catalog.getUpload(row.caller_id, row.upload_id));
    if (!ready) return yield* new C.SpaceAssetError({ reason: "not_ready" });
    const absent = yield* Upload.discardAbandonedStaging(
      ready,
      assetDirectories,
      recovered.success,
    );
    yield* transaction(Catalog.releaseStaging(ready, absent));
  }, assetErrors);
  const acquire = yield* Effect.cached(
    Layer.buildWithScope(Sqlite.layerFromPath(dbPath), scope).pipe(
      Effect.provide(platform),
      Effect.flatMap((context) =>
        Effect.gen(function* () {
          const sql = Context.get(context, SpacesSql.SpacesSql);
          yield* sql.withTransaction(
            Reconciliation.initialize().pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
          );
          yield* sql.withTransaction(
            SearchStore.checkModule().pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
          );
          yield* sql`UPDATE spaces_asset_reconciliation SET assets_done = 0,staging_done = 0 WHERE singleton = 1`;
          const environmentId = yield* identity.getEnvironmentId;
          const meta = yield* sql
            .withTransaction(Receipts.observe(environmentId))
            .pipe(Effect.provideService(SpacesSql.SpacesSql, sql));
          yield* sql`UPDATE spaces_asset_reconciliation SET cycle_started_ms = ${meta.observed_time_ms} WHERE singleton = 1 AND cycle_started_ms = 0`;
          const rows = yield* Catalog.recoveryBatch().pipe(
            Effect.provideService(SpacesSql.SpacesSql, sql),
          );
          // At most16 candidates plus4*20 row operations fit the100-row startup budget.
          for (const row of rows.slice(0, 4))
            yield* recover(row, meta.observed_time_ms).pipe(
              Effect.provideService(SpacesSql.SpacesSql, sql),
              Effect.catch(() => Effect.logWarning("Spaces asset recovery remains pending.")),
            );
          return sql;
        }),
      ),
      Effect.mapError(() => new C.SpacesUnavailableError({ stage: "initializing" })),
      Effect.provide(platform),
    ),
  );
  const admit = Effect.fn("SpacesService.admit")(function* () {
    const snapshot = yield* settings.getSettings.pipe(
      Effect.mapError(() => new C.SpacesUnavailableError({ stage: "settings" })),
    );
    if (!snapshot.spacesEnabled) return yield* new C.SpacesDisabledError();
    // A positive snapshot admits this call; disabling later does not cancel an accepted transaction.
    return yield* identity.getEnvironmentId;
  });
  const checkEnvironment = Effect.fn("SpacesService.checkEnvironment")(function* (
    actual: EnvironmentId,
    requested: EnvironmentId,
  ) {
    if (actual !== requested) {
      const size = byteLength(requested);
      if (size > limits.maxIdBytes)
        return yield* new C.SpaceLimitExceededError({
          limit: "maxIdBytes",
          actual: size,
          maximum: limits.maxIdBytes,
        });
      return yield* new C.SpaceEnvironmentMismatchError({ environmentId: requested });
    }
  });
  const run = Effect.fn("SpacesService.transaction")(function* <A>(
    environmentId: EnvironmentId,
    use: (
      meta: Receipts.Metadata,
      replay?: C.SpaceMutationReceipt,
    ) => Effect.Effect<A, C.SpaceServiceError | SqlError.SqlError, SpacesSql.SpacesSql>,
    maintenance: true | C.SpaceMutationRequest = true,
  ) {
    const sql = yield* acquire;
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        // Commit the observed clock even when the subsequent request is refused or rolled back.
        const meta = yield* sql.withTransaction(Receipts.observe(environmentId));
        const replay =
          maintenance === true ? undefined : yield* sql.withTransaction(Receipts.find(maintenance));
        if (!replay) {
          if (maintenance === true) yield* sql.withTransaction(Receipts.cleanup(meta));
          yield* sql.withTransaction(RevisionStore.prune(meta.observed_time_ms));
          yield* sql.withTransaction(ReferenceStore.maintain());
          yield* sql.withTransaction(Catalog.expireIdle(meta.observed_time_ms).pipe(assetErrors));
        }
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const [current] =
              yield* sql<Receipts.Metadata>`SELECT * FROM spaces_core WHERE singleton = 1`;
            if (!current) return yield* new C.SpacesUnavailableError({ stage: "storage" });
            return yield* use(current, replay);
          }),
        );
      }).pipe(
        Effect.provideService(SpacesSql.SpacesSql, sql),
        Effect.catchTags({
          SqlError: () => Effect.fail(new C.SpacesUnavailableError({ stage: "storage" })),
        }),
        Effect.catchDefect((cause) =>
          Effect.fail(
            isServiceError(cause) ? cause : new C.SpacesUnavailableError({ stage: "storage" }),
          ),
        ),
      ),
    );
  });
  const leaseUpload = Effect.fn("SpacesService.leaseUpload")((uploadId: string) =>
    Effect.try({
      try: () => {
        if (activeUploads.has(uploadId)) throw new C.SpaceAssetError({ reason: "already_claimed" });
        activeUploads.add(uploadId);
      },
      catch: () => new C.SpaceAssetError({ reason: "already_claimed" }),
    }),
  );
  const decodeAsset = <A, E>(raw: unknown, decode: (value: unknown) => Effect.Effect<A, E>) =>
    validateRaw(raw).pipe(
      Effect.flatMap(decode),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
  const createAssetUpload = Effect.fn("SpacesService.createAssetUpload")(function* (
    raw: unknown,
    callerId: string,
  ) {
    const environmentId = yield* admit();
    const input = yield* decodeAsset(raw, decodeAssetCreate);
    yield* checkEnvironment(environmentId, input.environmentId);
    const row = yield* run(environmentId, (meta) =>
      Catalog.reserve(
        {
          callerId,
          requestId: input.requestId,
          expectedBytes: input.expectedBytes,
          mimeType: input.mimeType,
          mediaKind: input.mediaKind,
          name: input.name,
        },
        meta.observed_time_ms,
      ).pipe(assetErrors),
    );
    const relativeUrl = yield* Tokens.issue(environmentId, row);
    return {
      uploadId: C.SpaceAssetUploadId.make(row.upload_id),
      assetId: C.SpaceAssetId.make(row.asset_id),
      expiresAt: row.expires_at_ms,
      relativeUrl,
    };
  });
  const getAssetUpload = Effect.fn("SpacesService.getAssetUpload")(function* (
    raw: unknown,
    callerId: string,
  ) {
    const environmentId = yield* admit();
    const input = yield* decodeAsset(raw, decodeAssetUpload);
    yield* checkEnvironment(environmentId, input.environmentId);
    const row = yield* run(environmentId, () =>
      Catalog.getUpload(callerId, input.uploadId).pipe(assetErrors),
    );
    return {
      uploadId: C.SpaceAssetUploadId.make(row.upload_id),
      assetId: C.SpaceAssetId.make(row.asset_id),
      expiresAt: row.expires_at_ms,
      state: row.state,
      recoveryPending:
        !activeUploads.has(row.upload_id) &&
        (row.state === "receiving" || row.state === "verified" || row.cleanup_pending === 1),
    };
  });
  const getAssetMetadata = Effect.fn("SpacesService.getAssetMetadata")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* decodeAsset(raw, decodeAssetGet);
    yield* checkEnvironment(environmentId, input.environmentId);
    const row = yield* run(environmentId, () =>
      Catalog.readyAsset(input.assetId).pipe(assetErrors),
    );
    return {
      assetId: C.SpaceAssetId.make(row.asset_id),
      digest: row.digest,
      byteSize: row.byte_size,
      mimeType: row.mime_type,
      name: row.name,
      ...(row.width !== null && row.height !== null
        ? { imageDimensions: { width: row.width, height: row.height } }
        : {}),
    };
  });
  const resolveAssetFile = Effect.fn("SpacesService.resolveAssetFile")(function* (raw: unknown) {
    const asset = yield* getAssetMetadata(raw);
    const filePath = path.join(
      yield* fs
        .realPath(assetDirectories.assetsDir)
        .pipe(Effect.mapError(() => new C.SpaceAssetError({ reason: "missing_file" }))),
      asset.digest,
    );
    const file = yield* openMediaFile(filePath).pipe(
      Effect.mapError(() => new C.SpaceAssetError({ reason: "missing_file" })),
    );
    if (!file || file.info.size !== BigInt(asset.byteSize))
      return yield* new C.SpaceAssetError({ reason: "missing_file" });
    return {
      path: filePath,
      file,
      digest: asset.digest,
      byteSize: asset.byteSize,
      name: asset.name,
      mimeType: asset.mimeType,
    };
  });
  const finalizeAssetUpload = Effect.fn("SpacesService.finalizeAssetUpload")(function* (
    raw: unknown,
    callerId: string,
  ) {
    const environmentId = yield* admit();
    const input = yield* decodeAsset(raw, decodeAssetUpload);
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* Effect.acquireUseRelease(
      leaseUpload(input.uploadId),
      () =>
        Effect.gen(function* () {
          let row = yield* run(environmentId, () =>
            Catalog.getUpload(callerId, input.uploadId).pipe(assetErrors),
          );
          if (row.state === "ready" && !row.cleanup_pending) return metadata(row);
          if (
            row.state === "verified" ||
            row.state === "receiving" ||
            (row.state === "ready" && row.cleanup_pending === 1)
          ) {
            const sql = yield* acquire;
            const now = yield* run(environmentId, (meta) => Effect.succeed(meta.observed_time_ms));
            yield* recover(row, now).pipe(
              Effect.provide(platform),
              Effect.provideService(SpacesSql.SpacesSql, sql),
            );
            row = yield* run(environmentId, () =>
              Catalog.getUpload(callerId, input.uploadId).pipe(assetErrors),
            );
          }
          if (row.state !== "ready")
            return yield* new C.SpaceAssetError({
              reason: row.state === "expired" ? "expired" : "not_ready",
            });
          return metadata(row);
        }),
      () =>
        Effect.sync(() => {
          activeUploads.delete(input.uploadId);
        }),
    );
  });
  const receiveAssetUpload = Effect.fn("SpacesService.receiveAssetUpload")(function* <E, R>(
    token: string,
    contentLength: string | undefined,
    body: Stream.Stream<Uint8Array, E, R>,
  ) {
    const environmentId = yield* admit();
    const grant = yield* Tokens.read(token);
    if (!grant) return yield* new C.SpaceAssetError({ reason: "invalid_token" });
    yield* checkEnvironment(environmentId, grant.environmentId);
    if (contentLength !== String(grant.expectedBytes))
      return yield* new C.SpaceAssetError({ reason: "invalid_content_length" });
    return yield* Effect.acquireUseRelease(
      leaseUpload(grant.uploadId),
      () =>
        Effect.gen(function* () {
          const claim = yield* run(environmentId, (meta) =>
            Effect.gen(function* () {
              const row = yield* Catalog.getUpload(grant.callerId, grant.uploadId);
              if (
                row.fingerprint !== grant.fingerprint ||
                row.expected_bytes !== grant.expectedBytes ||
                row.mime_type !== grant.mimeType ||
                row.media_kind !== grant.mediaKind ||
                row.expires_at_ms !== grant.expiresAt
              )
                return yield* new C.SpaceAssetError({ reason: "invalid_token" });
              return yield* Catalog.claim(grant.callerId, grant.uploadId, meta.observed_time_ms);
            }).pipe(assetErrors),
          );
          let verified = false;
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const staged = yield* Upload.stage<E, R>(
                claim,
                assetDirectories.stagingDir,
                body,
              ).pipe(assetErrors);
              const accepted = yield* run(environmentId, (meta) =>
                Catalog.recordVerified(claim, staged, meta.observed_time_ms).pipe(assetErrors),
              );
              verified = true;
              const proof = yield* Upload.publish(
                accepted,
                staged,
                assetDirectories.assetsDir,
              ).pipe(assetErrors);
              const result = yield* run(environmentId, (meta) =>
                Catalog.finish(accepted, proof, meta.observed_time_ms).pipe(assetErrors),
              );
              yield* staged.release.pipe(assetErrors);
              const ready = claimFrom(
                yield* run(environmentId, () =>
                  Catalog.getUpload(grant.callerId, grant.uploadId).pipe(assetErrors),
                ),
              );
              if (ready) {
                const absent = yield* Upload.confirmNoStaging(
                  ready,
                  assetDirectories.stagingDir,
                ).pipe(assetErrors);
                yield* run(environmentId, () =>
                  Catalog.releaseStaging(ready, absent).pipe(assetErrors),
                );
              }
              return { ...result, assetId: C.SpaceAssetId.make(result.assetId) };
            }),
          ).pipe(
            Effect.provide(platform),
            Effect.onExit((exit) =>
              exit._tag === "Failure" && !verified
                ? Effect.gen(function* () {
                    const absent = yield* Upload.confirmNoStaging(
                      claim,
                      assetDirectories.stagingDir,
                    );
                    yield* run(environmentId, (meta) =>
                      Catalog.abort(claim, absent, meta.observed_time_ms).pipe(assetErrors),
                    );
                  }).pipe(
                    Effect.provide(platform),
                    Effect.catch(() => Effect.logWarning("Spaces upload cleanup remains pending.")),
                  )
                : Effect.void,
            ),
          );
        }),
      () =>
        Effect.sync(() => {
          activeUploads.delete(grant.uploadId);
        }),
    );
  });
  const getSpace = Effect.fn("SpacesService.space")(function* (id: C.SpaceId) {
    const sql = yield* SpacesSql.SpacesSql;
    const [row] = yield* sql<SpaceRow>`SELECT * FROM spaces WHERE space_id = ${id}`;
    if (!row) return yield* new C.SpaceNotFoundError({ entity: "space", id });
    return row;
  });
  const getPageRow = PageStore.read;
  const defaultSpace = Effect.fn("SpacesService.default")(function* () {
    const sql = yield* SpacesSql.SpacesSql;
    const [row] = yield* sql<SpaceRow>`SELECT * FROM spaces WHERE is_default = 1`;
    if (!row) return yield* new C.SpacesUnavailableError({ stage: "storage" });
    return row;
  });
  const listSpaces = Effect.fn("SpacesService.listSpaces")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeList),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* run(environmentId, (meta) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        checkIds(input);
        const limit = input.limit ?? limits.maxListRows;
        checkLimit("maxListRows", limit);
        const cursor = cursorFrom(
          input.cursor,
          environmentId,
          "listSpaces",
          "",
          meta.catalog_revision,
        );
        const rows = cursor
          ? yield* sql<SpaceRow>`SELECT * FROM spaces WHERE (created_at, space_id) > (${cursor.key}, ${cursor.id}) ORDER BY created_at, space_id LIMIT ${limit + 1}`
          : yield* sql<SpaceRow>`SELECT * FROM spaces ORDER BY created_at, space_id LIMIT ${limit + 1}`;
        const admission = yield* Receipts.issue(meta);
        const def = yield* defaultSpace();
        let take = Math.min(limit, rows.length);
        while (true) {
          const last = rows[take - 1];
          const result: C.SpaceListResult = {
            items: rows.slice(0, take).map(spaceSummary),
            defaultSpaceId: def.space_id,
            catalogRevision: meta.catalog_revision,
            nextCursor:
              take < rows.length && last
                ? cursorFor(
                    environmentId,
                    "listSpaces",
                    "",
                    meta.catalog_revision,
                    last.created_at,
                    last.space_id,
                  )
                : null,
            mutationAdmission: admission,
          };
          const size = byteLength(result);
          if (size <= limits.maxListResponseBytes) return result;
          if (take <= 1) {
            checkLimit("maxListResponseBytes", size);
          }
          take--;
        }
      }),
    );
  });
  const listPages = Effect.fn("SpacesService.listPages")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodePages),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* run(environmentId, (meta) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        checkIds(input);
        const space = yield* getSpace(input.spaceId);
        const limit = input.limit ?? limits.maxListRows;
        checkLimit("maxListRows", limit);
        if (input.parentPageId !== undefined)
          PageStore.assertActive(yield* getPageRow(input.parentPageId));
        if (
          input.parentPageId !== undefined &&
          (yield* getPageRow(input.parentPageId)).space_id !== input.spaceId
        )
          return yield* new C.SpaceNotFoundError({ entity: "page", id: input.parentPageId });
        const filter = canonical({
          spaceId: input.spaceId,
          parentPageId: input.parentPageId ?? null,
        });
        const cursor = cursorFrom(
          input.cursor,
          environmentId,
          "listPages",
          filter,
          meta.catalog_revision,
        );
        const after =
          cursor === undefined
            ? sql``
            : input.parentPageId === undefined
              ? sql`AND (p.root_order,p.page_id) > (${cursor.key},${cursor.id})`
              : sql`AND (b.rank,b.block_id) > (${cursor.key},${cursor.id})`;
        const rows =
          input.parentPageId === undefined
            ? yield* sql<PageListCandidate>`SELECT p.*, p.root_order AS list_order, p.page_id AS list_id, o.owner_block_id, b.page_id AS parent_page_id, b.deleted AS owner_deleted, parent.space_id AS parent_space_id, json_extract(b.payload,'$.type') AS owner_type
              FROM spaces_pages p LEFT JOIN spaces_page_owners o ON o.child_page_id = p.page_id
              LEFT JOIN spaces_blocks b ON b.block_id = o.owner_block_id LEFT JOIN spaces_pages parent ON parent.page_id = b.page_id WHERE p.space_id = ${input.spaceId} AND p.root_order IS NOT NULL AND p.trash_batch_id IS NULL
              ${after}
              ORDER BY p.root_order,p.page_id LIMIT ${limit + 1}`
            : yield* sql<PageListCandidate>`SELECT p.*, b.rank AS list_order, b.block_id AS list_id, o.owner_block_id,
              b.page_id AS parent_page_id, 0 AS owner_deleted, parent.space_id AS parent_space_id,
              'child_page' AS owner_type
              FROM (SELECT b.block_id,b.page_id,b.rank FROM spaces_blocks b
                WHERE b.page_id=${input.parentPageId} AND b.deleted=0 AND json_extract(b.payload,'$.type')='child_page'
                ${after} ORDER BY b.rank,b.block_id LIMIT ${limit + 1}) b
              LEFT JOIN spaces_page_owners o ON o.owner_block_id=b.block_id
              LEFT JOIN spaces_pages p ON p.page_id=o.child_page_id
              LEFT JOIN spaces_pages parent ON parent.page_id=b.page_id
              ORDER BY b.rank,b.block_id`;
        const admission = yield* Receipts.issue(meta);
        let take = Math.min(limit, rows.length);
        while (true) {
          const last = rows[take - 1];
          const result: C.SpacePageListResult = {
            space: spaceSummary(space),
            items: rows
              .slice(0, take)
              .filter(
                (row): row is PageRow & PageListCandidate =>
                  row.page_id !== null &&
                  row.space_id === input.spaceId &&
                  row.trash_batch_id === null,
              )
              .map((row) => pageSummary(row)),
            catalogRevision: meta.catalog_revision,
            nextCursor:
              take < rows.length && last
                ? cursorFor(
                    environmentId,
                    "listPages",
                    filter,
                    meta.catalog_revision,
                    last.list_order,
                    last.list_id,
                  )
                : null,
            mutationAdmission: admission,
          };
          const size = byteLength(result);
          if (size <= limits.maxListResponseBytes) return result;
          if (take <= 1) checkLimit("maxListResponseBytes", size);
          take--;
        }
      }),
    );
  });
  const search = Effect.fn("SpacesService.search")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeSearch),
      Effect.mapError((error) =>
        isServiceError(error) ? error : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    const result = yield* run(environmentId, (meta) =>
      Effect.gen(function* () {
        checkIds(input);
        const query = SearchStore.literalQuery(input.query);
        const limit = input.limit ?? searchLimits.maxRows;
        checkSearchLimit("maxRows", limit);
        const filter = NodeCrypto.createHash("sha256")
          .update(canonical({ query: input.query, spaceId: input.spaceId ?? null }))
          .digest("hex");
        const cursor = cursorFrom(
          input.cursor,
          environmentId,
          "search",
          filter,
          meta.catalog_revision,
        );
        const after = cursor === undefined ? 0 : Number(cursor.id);
        if (
          !Number.isSafeInteger(after) ||
          after < 0 ||
          (cursor && (String(after) !== cursor.id || cursor.key !== "doc"))
        )
          return yield* new C.SpaceValidationError({ reason: "invalid_cursor" });
        const status = yield* SearchStore.advance();
        if (status !== "ready") return new C.SpaceSearchUnavailableError({ reason: status });
        const rows = yield* SearchStore.candidates(query, after);
        const items: C.SpaceSearchResult["items"][number][] = [];
        let bytes = byteLength(rows.map((row) => ({ ...row })));
        checkSearchLimit("maxCandidateBytes", bytes);
        let consumed = 0;
        let last = after;
        for (const row of rows.slice(0, searchLimits.maxCandidates)) {
          const size = 8 + row.text_json_bytes;
          if (bytes + size > searchLimits.maxCandidateBytes) {
            if (consumed === 0) checkSearchLimit("maxCandidateBytes", bytes + size);
            break;
          }
          const visible =
            row.page_id !== null &&
            row.trash_batch_id === null &&
            (input.spaceId === undefined || row.space_id === input.spaceId);
          const item = visible
            ? {
                page: PageStore.summary(row),
                ...(row.block_id === null ? {} : { blockId: row.block_id }),
                snippet: yield* SearchStore.snippet(query, row.doc_id),
              }
            : undefined;
          if (item) {
            const proposed: C.SpaceSearchResult = {
              catalogRevision: meta.catalog_revision,
              items: [...items, item],
              nextCursor: cursorFor(
                environmentId,
                "search",
                filter,
                meta.catalog_revision,
                "doc",
                String(row.doc_id),
              ),
            };
            const responseBytes = byteLength(proposed);
            if (responseBytes > searchLimits.maxResponseBytes) {
              if (consumed === 0) checkSearchLimit("maxResponseBytes", responseBytes);
              break;
            }
            items.push(item);
          }
          bytes += size;
          consumed++;
          last = row.doc_id;
          if (items.length === limit) break;
        }
        return {
          catalogRevision: meta.catalog_revision,
          items,
          nextCursor:
            consumed < rows.length || rows.length === searchLimits.maxCandidates
              ? cursorFor(
                  environmentId,
                  "search",
                  filter,
                  meta.catalog_revision,
                  "doc",
                  String(last),
                )
              : null,
        } satisfies C.SpaceSearchResult;
      }),
    );
    if (isSearchUnavailable(result)) return yield* result;
    return result;
  });
  const listTrash = Effect.fn("SpacesService.listTrash")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeTrashList),
      Effect.mapError((error) =>
        isServiceError(error) ? error : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* run(environmentId, (meta) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        const limit = input.limit ?? limits.maxListRows;
        checkLimit("maxListRows", limit);
        const cursor = cursorFrom(
          input.cursor,
          environmentId,
          "listTrash",
          "",
          meta.catalog_revision,
        );
        const time = cursor === undefined ? 0 : Number(cursor.key);
        if (!Number.isSafeInteger(time) || time < 0)
          return yield* new C.SpaceValidationError({ reason: "invalid_cursor" });
        const after =
          cursor === undefined
            ? sql``
            : sql`AND (p.trashed_at_ms,p.page_id)>(${time},${cursor.id})`;
        const rows = yield* sql<
          Pick<
            PageRow,
            | "page_id"
            | "space_id"
            | "title"
            | "revision"
            | "trash_batch_id"
            | "trash_root_id"
            | "trashed_at_ms"
          > & { readonly is_trash_root: number }
        >`
        SELECT p.*, CASE WHEN o.owner_block_id IS NULL OR b.block_id IS NULL OR b.deleted!=0 OR parent.trash_batch_id IS NULL OR parent.trash_batch_id!=p.trash_batch_id THEN 1 ELSE 0 END AS is_trash_root
        FROM (SELECT p.* FROM spaces_pages p WHERE p.trash_batch_id IS NOT NULL ${after} ORDER BY p.trashed_at_ms,p.page_id LIMIT ${limit + 1}) p
        LEFT JOIN spaces_page_owners o ON o.child_page_id=p.page_id LEFT JOIN spaces_blocks b ON b.block_id=o.owner_block_id LEFT JOIN spaces_pages parent ON parent.page_id=b.page_id ORDER BY p.trashed_at_ms,p.page_id`;
        const admission = yield* Receipts.issue(meta);
        let take = Math.min(limit, rows.length);
        while (true) {
          const last = rows[take - 1];
          const result: C.SpaceTrashListResult = {
            catalogRevision: meta.catalog_revision,
            items: rows
              .slice(0, take)
              .filter((row) => row.is_trash_root === 1)
              .map((row) => ({
                pageId: row.page_id,
                spaceId: row.space_id,
                title: row.title,
                revision: row.revision,
                trash: PageStore.trashStatus(row),
              })),
            nextCursor:
              take < rows.length && last
                ? cursorFor(
                    environmentId,
                    "listTrash",
                    "",
                    meta.catalog_revision,
                    String(last.trashed_at_ms),
                    last.page_id,
                  )
                : null,
            mutationAdmission: admission,
          };
          const size = byteLength(result);
          if (size <= limits.maxListResponseBytes) return result;
          if (take <= 1) checkLimit("maxListResponseBytes", size);
          take--;
        }
      }),
    );
  });
  const getPage = Effect.fn("SpacesService.getPage")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeGet),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* run(environmentId, (meta) =>
      Effect.gen(function* () {
        checkIds(input);
        const page = yield* getPageRow(input.pageId);
        PageStore.assertActive(page);
        const space = yield* getSpace(page.space_id);
        const result = {
          page: pageSummary(page),
          space: spaceSummary(space),
          mutationAdmission: yield* Receipts.issue(meta),
        };
        checkLimit("maxListResponseBytes", byteLength(result));
        return result;
      }),
    );
  });
  const readBlocks = Effect.fn("SpacesService.readBlocks")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeBlocks),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* run(environmentId, () =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        checkIds(input);
        const page = yield* getPageRow(input.pageId);
        PageStore.assertActive(page);
        if (page.revision !== input.revision)
          return yield* new C.SpaceCursorStaleError({ revision: page.revision });
        const limit = input.limit ?? limits.maxBlockWindowBlocks;
        checkLimit("maxBlockWindowBlocks", limit);
        const cursor = cursorFrom(
          input.cursor,
          environmentId,
          "readBlocks",
          input.pageId,
          page.revision,
        );
        const firstChild = Effect.fnUntraced(function* (parent: string | null) {
          const [row] =
            yield* sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks WHERE page_id = ${input.pageId} AND deleted = 0 AND parent_id IS ${parent} ORDER BY rank, block_id LIMIT 1`;
          return row;
        });
        const successor = Effect.fnUntraced(function* (row: BlockStore.BlockRow) {
          const child = yield* firstChild(row.block_id);
          if (child) return child;
          const seen = new Set<string>();
          let node = row;
          while (true) {
            if (seen.has(node.block_id))
              return yield* new C.SpaceValidationError({ reason: "cycle" });
            seen.add(node.block_id);
            checkLimit("maxDepth", seen.size);
            const [sibling] =
              yield* sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks WHERE page_id = ${input.pageId} AND deleted = 0 AND parent_id IS ${node.parent_id} AND (rank, block_id) > (${node.rank}, ${node.block_id}) ORDER BY rank, block_id LIMIT 1`;
            if (sibling) return sibling;
            if (node.parent_id === null) return undefined;
            const [parent] =
              yield* sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks WHERE page_id = ${input.pageId} AND deleted = 0 AND block_id = ${node.parent_id}`;
            if (!parent) return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
            node = parent;
          }
        });
        let row: BlockStore.BlockRow | undefined;
        if (cursor) {
          const [last] =
            yield* sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks WHERE block_id = ${cursor.id} AND page_id = ${input.pageId} AND deleted = 0`;
          if (!last || last.rank !== cursor.key)
            return yield* new C.SpaceValidationError({ reason: "invalid_cursor" });
          row = yield* successor(last);
        } else row = yield* firstChild(null);
        const blocks: C.SpaceBlock[] = [];
        const seen = new Set<string>();
        let nextCursor: C.SpaceCursor | null = null;
        while (row && blocks.length < limit) {
          if (seen.has(row.block_id)) return yield* new C.SpaceValidationError({ reason: "cycle" });
          seen.add(row.block_id);
          const next = yield* successor(row);
          const candidate = [...blocks, yield* BlockStore.blockFromRow(row)];
          const continuation = next
            ? cursorFor(
                environmentId,
                "readBlocks",
                input.pageId,
                page.revision,
                row.rank,
                row.block_id,
              )
            : null;
          const size = byteLength({
            revision: page.revision,
            blocks: candidate,
            nextCursor: continuation,
          });
          if (size > limits.maxBlockWindowResponseBytes) {
            if (!blocks.length) checkLimit("maxBlockWindowResponseBytes", size);
            break;
          }
          blocks.push(candidate[candidate.length - 1]!);
          nextCursor = continuation;
          row = next;
        }
        return { revision: page.revision, blocks, nextCursor };
      }),
    );
  });
  const inspectStructure = Effect.fn("SpacesService.inspectStructure")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeInspect),
      Effect.mapError((error) =>
        isServiceError(error) ? error : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* run(environmentId, (meta) =>
      Effect.gen(function* () {
        checkIds(input);
        checkLimit("maxMutationBytes", byteLength(input));
        const plan = yield* PageStructure.plan(input, byteLength(input));
        if (input.recovery === "permanentlyDelete") yield* PageRecovery.prepare(plan);
        const result: C.SpaceInspectStructureResult = {
          ...(input.recovery
            ? { recovery: { operation: input.recovery, pageIds: [...plan.recoveryPages] } }
            : {}),
          catalogRevision: meta.catalog_revision,
          guards: plan.guards,
          pages: [...plan.pages.values()].map((row) =>
            PageStore.summary(row, input.recovery !== undefined),
          ),
          blockIds: [...plan.blocks.keys()].map((id) => C.SpaceBlockId.make(id)),
        };
        checkLimit("maxBlockWindowResponseBytes", byteLength(result));
        return result;
      }),
    );
  });
  const resolveReference = Effect.fn("SpacesService.resolveReference")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeReference),
      Effect.mapError((error) =>
        isServiceError(error) ? error : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    checkIds(input);
    checkLimit("maxMutationBytes", byteLength(input));
    return yield* run(environmentId, () => ReferenceStore.resolve(input.target));
  });
  const execute = Effect.fn("SpacesService.execute")(function* (
    request: C.SpaceMutationRequest,
    meta: Receipts.Metadata,
  ) {
    const sql = yield* SpacesSql.SpacesSql;
    const input = request.input;
    const now = DateTime.formatIso(DateTime.makeUnsafe(meta.observed_time_ms));
    const ack = { mutationId: input.mutationId, receiptEpoch: input.receiptEpoch };
    const conflict = Effect.fnUntraced(function* (
      spaces: readonly SpaceRow[],
      pages: readonly PageRow[] = [],
    ) {
      const def = yield* defaultSpace();
      return {
        status: "conflict" as const,
        ...ack,
        current: {
          catalogRevision: meta.catalog_revision,
          defaultSpaceId: def.space_id,
          spaces: spaces.map(spaceSummary),
          pages: pages.map((row) => pageSummary(row)),
        },
      };
    });
    const changed = Effect.fnUntraced(function* () {
      yield* sql`UPDATE spaces_core SET catalog_revision = catalog_revision + 1 WHERE singleton = 1`;
    });
    switch (request.operation) {
      case "trashPage":
      case "restorePage":
      case "permanentlyDeletePage":
      case "createChildPage":
      case "moveBlocks":
      case "movePage": {
        const structural =
          request.operation === "trashPage" ||
          request.operation === "restorePage" ||
          request.operation === "permanentlyDeletePage"
            ? {
                environmentId: request.input.environmentId,
                target: { kind: "page" as const, pageId: request.input.pageId },
                recovery:
                  request.operation === "trashPage"
                    ? ("trash" as const)
                    : request.operation === "restorePage"
                      ? ("restore" as const)
                      : ("permanentlyDelete" as const),
              }
            : request.operation === "moveBlocks"
              ? {
                  environmentId: request.input.environmentId,
                  target: {
                    kind: "blocks" as const,
                    pageId: request.input.sourcePageId,
                    blockIds: request.input.blockIds,
                  },
                  destination: { kind: "child" as const, placement: request.input.destination },
                }
              : request.operation === "createChildPage"
                ? {
                    environmentId: request.input.environmentId,
                    target: {
                      kind: "blocks" as const,
                      pageId: request.input.placement.pageId,
                      blockIds: [],
                    },
                    destination: { kind: "child" as const, placement: request.input.placement },
                  }
                : {
                    environmentId: request.input.environmentId,
                    target: { kind: "page" as const, pageId: request.input.pageId },
                    destination: request.input.destination,
                  };
        const plan = yield* PageStructure.plan(structural, byteLength(request));
        if (!PageStructure.guardsMatch(plan, request.input.guards)) {
          const def = yield* defaultSpace();
          return decodeReceipt({
            operation: request.operation,
            result: {
              status: "conflict",
              ...ack,
              current: {
                catalogRevision: meta.catalog_revision,
                defaultSpaceId: def.space_id,
                ...plan.guards,
              },
            },
          });
        }
        const result =
          request.operation === "permanentlyDeletePage"
            ? yield* PageRecovery.purge(plan, request.input.mutationId, meta.observed_time_ms)
            : yield* PageStructure.apply(
                plan,
                request.input.mutationId,
                meta.observed_time_ms,
                request.operation === "createChildPage" ? request.input.title : undefined,
              );
        return decodeReceipt({
          operation: request.operation,
          result: { status: "saved", ...ack, ...result },
        });
      }
      case "createSpace": {
        const input = request.input;
        const id = C.SpaceId.make(NodeCrypto.randomUUID());
        yield* sql`INSERT INTO spaces_ids (id, kind) VALUES (${id}, 'space')`;
        yield* sql`INSERT INTO spaces (space_id, title, is_default, created_at, updated_at) VALUES (${id}, ${input.title}, 0, ${now}, ${now})`;
        yield* changed();
        return decodeReceipt({
          operation: request.operation,
          result: { status: "saved", ...ack, space: spaceSummary(yield* getSpace(id)) },
        });
      }
      case "renameSpace": {
        const input = request.input;
        const space = yield* getSpace(input.spaceId);
        if (space.revision !== input.baseRevision)
          return decodeReceipt({ operation: request.operation, result: yield* conflict([space]) });
        if (space.title !== input.title) {
          yield* sql`UPDATE spaces SET title = ${input.title}, revision = revision + 1, updated_at = ${now} WHERE space_id = ${input.spaceId}`;
          yield* changed();
        }
        return decodeReceipt({
          operation: request.operation,
          result: { status: "saved", ...ack, space: spaceSummary(yield* getSpace(input.spaceId)) },
        });
      }
      case "setDefaultSpace": {
        const input = request.input;
        const space = yield* getSpace(input.spaceId);
        const previous = yield* getSpace(input.defaultSpaceId);
        const def = yield* defaultSpace();
        if (
          space.revision !== input.baseRevision ||
          previous.revision !== input.baseDefaultRevision ||
          previous.space_id !== def.space_id
        ) {
          return decodeReceipt({
            operation: request.operation,
            result: yield* conflict(space.space_id === def.space_id ? [space] : [space, def]),
          });
        }
        if (space.space_id !== previous.space_id) {
          yield* sql`UPDATE spaces SET is_default = 0, revision = revision + 1, updated_at = ${now} WHERE space_id = ${previous.space_id}`;
          yield* sql`UPDATE spaces SET is_default = 1, revision = revision + 1, updated_at = ${now} WHERE space_id = ${space.space_id}`;
          yield* changed();
        }
        return decodeReceipt({
          operation: request.operation,
          result: {
            status: "saved",
            ...ack,
            space: spaceSummary(yield* getSpace(space.space_id)),
            previousDefaultSpace: spaceSummary(yield* getSpace(previous.space_id)),
          },
        });
      }
      case "createPage": {
        const input = request.input;
        const space = yield* getSpace(input.spaceId);
        if (space.root_order_revision !== input.baseRootOrderRevision)
          return decodeReceipt({ operation: request.operation, result: yield* conflict([space]) });
        const [last] = yield* sql<{
          readonly root_order: string;
        }>`SELECT root_order FROM spaces_pages WHERE space_id = ${input.spaceId} AND root_order IS NOT NULL ORDER BY root_order DESC, page_id DESC LIMIT 1`;
        const rank = last ? BigInt(`0x${last.root_order}`) + 1n : 1n;
        if (rank >= 1n << 128n)
          return yield* new C.SpaceValidationError({ reason: "invalid_order" });
        const id = C.SpacePageId.make(NodeCrypto.randomUUID());
        yield* sql`INSERT INTO spaces_ids (id, kind) VALUES (${id}, 'page')`;
        yield* sql`INSERT INTO spaces_pages (page_id, space_id, title, root_order, created_at, updated_at)
          VALUES (${id}, ${input.spaceId}, ${input.title}, ${rank.toString(16).padStart(32, "0")}, ${now}, ${now})`;
        yield* SearchStore.writeTitle(id, input.title);
        yield* RevisionStore.capture(
          {
            pageId: id,
            toRevision: 0,
            mutationId: input.mutationId,
            pageBefore: null,
            blocksBefore: [],
          },
          meta.observed_time_ms,
        );
        yield* sql`UPDATE spaces SET root_order_revision = root_order_revision + 1, updated_at = ${now} WHERE space_id = ${input.spaceId}`;
        yield* changed();
        return decodeReceipt({
          operation: request.operation,
          result: {
            status: "saved",
            ...ack,
            page: pageSummary(yield* getPageRow(id)),
            space: spaceSummary(yield* getSpace(input.spaceId)),
          },
        });
      }
      case "updatePage": {
        const input = request.input;
        const page = yield* getPageRow(input.pageId);
        PageStore.assertActive(page);
        if (page.revision !== input.baseRevision)
          return decodeReceipt({
            operation: request.operation,
            result: yield* conflict([yield* getSpace(page.space_id)], [page]),
          });
        if (page.title !== input.title) {
          yield* SearchStore.writeTitle(input.pageId, input.title);
          yield* sql`UPDATE spaces_pages SET title = ${input.title}, revision = revision + 1, updated_at = ${now} WHERE page_id = ${input.pageId}`;
          yield* RevisionStore.capture(
            {
              pageId: input.pageId,
              toRevision: page.revision + 1,
              mutationId: input.mutationId,
              pageBefore: pagePreimage(page),
              blocksBefore: [],
            },
            meta.observed_time_ms,
          );
          yield* changed();
        }
        return decodeReceipt({
          operation: request.operation,
          result: { status: "saved", ...ack, page: pageSummary(yield* getPageRow(input.pageId)) },
        });
      }
      case "applyBlockBatch": {
        const input = request.input;
        const page = yield* getPageRow(input.pageId);
        PageStore.assertActive(page);
        if (page.revision !== input.baseRevision)
          return decodeReceipt({
            operation: request.operation,
            result: {
              ...(yield* conflict([yield* getSpace(page.space_id)], [page])),
              generation: input.generation,
              revision: page.revision,
            },
          });
        const result = yield* BlockStore.apply(
          input.pageId,
          input.mutations,
          page.block_count,
          page.block_bytes,
          byteLength(request),
        );
        if (result.changed) {
          yield* sql`UPDATE spaces_pages SET revision = revision + 1, block_count = ${result.count}, block_bytes = ${result.bytes}, updated_at = ${now} WHERE page_id = ${input.pageId}`;
          yield* RevisionStore.capture(
            {
              pageId: input.pageId,
              toRevision: page.revision + 1,
              mutationId: input.mutationId,
              pageBefore: pagePreimage(page),
              blocksBefore: result.blocksBefore,
            },
            meta.observed_time_ms,
          );
          yield* AssetReferences.publish(result.assetRefsAfter);
          for (const changedBlock of result.blocksAfter)
            yield* Reconciliation.noteBlock(changedBlock.id, changedBlock.payload);
          yield* ReferenceStore.release(result.retiredIds);
          yield* changed();
        }
        return decodeReceipt({
          operation: request.operation,
          result: {
            status: "saved",
            ...ack,
            generation: input.generation,
            revision: page.revision + (result.changed ? 1 : 0),
          },
        });
      }
    }
  });
  const mutate = Effect.fn("SpacesService.mutate")(function* (
    operation: C.SpaceMutationRequest["operation"],
    raw: unknown,
  ) {
    const environmentId = yield* admit();
    const request = yield* validateRaw({ operation, input: raw }).pipe(
      Effect.flatMap(decodeRequest),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, request.input.environmentId);
    return yield* run(
      environmentId,
      (meta, replay) =>
        Effect.gen(function* () {
          const found = replay ?? (yield* Receipts.find(request));
          if (found) return found;
          checkLimit("maxMutationBytes", byteLength(request));
          checkIds(request.input);
          if ("title" in request.input)
            checkLimit("maxTitleBytes", byteLength(request.input.title));
          if (request.operation === "applyBlockBatch")
            checkLimit("maxMutationNodes", request.input.mutations.length);
          const epoch = yield* Receipts.active(meta);
          if (!epoch || epoch.epoch !== request.input.receiptEpoch)
            return yield* new C.SpaceMutationAdmissionError({
              receiptEpoch: request.input.receiptEpoch,
            });
          const receipt = yield* execute(request, meta);
          yield* Receipts.store(request, receipt, meta, epoch.retain_until);
          return receipt;
        }),
      request,
    );
  });
  const createSpace = Effect.fn("SpacesService.createSpace")(function* (input: unknown) {
    return decodeCreateResult((yield* mutate("createSpace", input)).result);
  });
  const renameSpace = Effect.fn("SpacesService.renameSpace")(function* (input: unknown) {
    return decodeRenameResult((yield* mutate("renameSpace", input)).result);
  });
  const setDefaultSpace = Effect.fn("SpacesService.setDefaultSpace")(function* (input: unknown) {
    return decodeDefaultResult((yield* mutate("setDefaultSpace", input)).result);
  });
  const createPage = Effect.fn("SpacesService.createPage")(function* (input: unknown) {
    return decodePageCreateResult((yield* mutate("createPage", input)).result);
  });
  const updatePage = Effect.fn("SpacesService.updatePage")(function* (input: unknown) {
    return decodePageUpdateResult((yield* mutate("updatePage", input)).result);
  });
  const applyBlockBatch = Effect.fn("SpacesService.applyBlockBatch")(function* (input: unknown) {
    return decodeApplyResult((yield* mutate("applyBlockBatch", input)).result);
  });
  const createChildPage = Effect.fn("SpacesService.createChildPage")(function* (input: unknown) {
    return decodeCreateChildResult((yield* mutate("createChildPage", input)).result);
  });
  const movePage = Effect.fn("SpacesService.movePage")(function* (input: unknown) {
    return decodeMovePageResult((yield* mutate("movePage", input)).result);
  });
  const moveBlocks = Effect.fn("SpacesService.moveBlocks")(function* (input: unknown) {
    return decodeMoveBlocksResult((yield* mutate("moveBlocks", input)).result);
  });
  const trashPage = Effect.fn("SpacesService.trashPage")(function* (input: unknown) {
    return decodeRecoveryResult((yield* mutate("trashPage", input)).result);
  });
  const restorePage = Effect.fn("SpacesService.restorePage")(function* (input: unknown) {
    return decodeRecoveryResult((yield* mutate("restorePage", input)).result);
  });
  const permanentlyDeletePage = Effect.fn("SpacesService.permanentlyDeletePage")(function* (
    input: unknown,
  ) {
    return decodePurgeResult((yield* mutate("permanentlyDeletePage", input)).result);
  });
  const lookupMutationReceipt = Effect.fn("SpacesService.lookupMutationReceipt")(function* (
    raw: unknown,
  ): Effect.fn.Return<C.SpaceReceiptLookupResult, C.SpaceServiceError> {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeLookup),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.request.input.environmentId);
    return yield* run(
      environmentId,
      (meta, replay) =>
        Effect.gen(function* () {
          const receipt = replay ?? (yield* Receipts.find(input.request));
          if (receipt) return { status: "found" as const, receipt };
          checkIds(input.request.input);
          const epoch = yield* Receipts.active(meta);
          return {
            status:
              epoch?.epoch === input.request.input.receiptEpoch
                ? ("absent" as const)
                : ("unknown" as const),
          };
        }),
      input.request,
    );
  });
  const getCapability = Effect.fn("SpacesService.getCapability")(
    function* (requested: EnvironmentId) {
      const environmentId = yield* admit();
      yield* checkEnvironment(environmentId, requested);
      return yield* run(environmentId, (meta) =>
        Effect.gen(function* () {
          yield* Receipts.issue(meta);
          const assetRecoveryPending =
            yield* Catalog.hasRecoveryPending(activeUploads).pipe(assetErrors);
          return {
            version: 2,
            limits,
            assetRecoveryPending,
            assetReconciliation: yield* Reconciliation.status(),
            features: {
              blockMoves: true,
              referenceResolution: true,
              recovery: true,
              search: true,
            },
          } satisfies C.SpaceCapability;
        }),
      );
    },
    Effect.catchTags({
      SpacesDisabledError: () => Effect.succeed(null),
      SpacesUnavailableError: () => Effect.succeed(null),
    }),
  );
  const maintainAssets = maintenanceMutex.withPermits(1)(
    Effect.gen(function* () {
      const snapshot = yield* settings.getSettings.pipe(
        Effect.mapError(() => new C.SpacesUnavailableError({ stage: "settings" })),
      );
      if (!snapshot.spacesEnabled) return null;
      const environmentId = yield* identity.getEnvironmentId;
      const progress = yield* run(environmentId, (meta) =>
        Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          const current = yield* Reconciliation.state();
          if (
            current.blocks_done &&
            current.history_done &&
            current.blobs_done &&
            current.assets_done &&
            current.staging_done &&
            meta.observed_time_ms - current.cycle_started_ms >= 86_400_000
          )
            yield* sql`UPDATE spaces_asset_reconciliation SET block_cursor = '',blocks_done = 0,history_page = '',history_revision = -1,history_done = 0,
            blob_cursor = '',blobs_done = 0,assets_done = 0,staging_done = 0,cycle_started_ms = ${meta.observed_time_ms} WHERE singleton = 1`;
          return yield* Reconciliation.state();
        }),
      );
      if (!progress.blocks_done || !progress.history_done) {
        yield* run(environmentId, () => Reconciliation.referencesPass());
      } else if (!progress.blobs_done) {
        const [blob] = yield* run(environmentId, () =>
          Effect.gen(function* () {
            const sql = yield* SpacesSql.SpacesSql;
            return yield* sql<{
              readonly digest: string;
              readonly byte_size: number;
              readonly generation: number;
              readonly state: string;
              readonly mime_type: string;
              readonly media_kind: string;
            }>`
          SELECT digest,byte_size,generation,state,mime_type,media_kind FROM spaces_asset_blobs WHERE digest > ${progress.blob_cursor} ORDER BY digest LIMIT 1`;
          }),
        );
        const valid = blob ? yield* inventory.verify(blob) : true;
        yield* run(environmentId, () =>
          Effect.gen(function* () {
            const sql = yield* SpacesSql.SpacesSql;
            if (!blob)
              yield* sql`UPDATE spaces_asset_reconciliation SET blobs_done = 1 WHERE singleton = 1`;
            else {
              const [current] = yield* sql<{
                readonly generation: number;
                readonly state: string;
              }>`SELECT generation,state FROM spaces_asset_blobs WHERE digest = ${blob.digest}`;
              if (current?.generation === blob.generation && current.state === blob.state)
                yield* Reconciliation.issue(
                  "blob",
                  blob.digest,
                  blob.state === "ready" && valid ? null : "unavailable_file",
                );
              yield* sql`UPDATE spaces_asset_reconciliation SET blob_cursor = ${blob.digest} WHERE singleton = 1`;
            }
          }),
        );
      } else {
        const now = yield* run(environmentId, (meta) => Effect.succeed(meta.observed_time_ms));
        for (const kind of ["assets", "staging"] as const) {
          if ((kind === "assets" ? progress.assets_done : progress.staging_done) === 1) continue;
          const found = yield* inventory
            .discover(
              kind,
              now,
              kind === "assets" ? progress.assets_generation : progress.staging_generation,
            )
            .pipe(Effect.mapError(() => new C.SpacesUnavailableError({ stage: "storage" })));
          yield* run(environmentId, () =>
            Effect.gen(function* () {
              const sql = yield* SpacesSql.SpacesSql;
              for (const entry of found.entries) yield* inventory.record(entry);
              if (found.done) {
                if (kind === "assets")
                  yield* sql`UPDATE spaces_asset_reconciliation SET assets_done = 1 WHERE singleton = 1 AND assets_generation = ${found.generation}`;
                else
                  yield* sql`UPDATE spaces_asset_reconciliation SET staging_done = 1 WHERE singleton = 1 AND staging_generation = ${found.generation}
                    AND NOT EXISTS (SELECT 1 FROM spaces_asset_uploads WHERE state = 'receiving')`;
              }
            }),
          );
          yield* inventory.acknowledge(kind);
        }
        const entries = yield* run(environmentId, () =>
          Effect.gen(function* () {
            const sql = yield* SpacesSql.SpacesSql;
            return yield* sql<{
              readonly kind: string;
              readonly name: string;
            }>`SELECT kind,name FROM spaces_asset_file_observations
          WHERE (kind,name) > (${progress.file_kind},${progress.file_cursor}) ORDER BY kind,name LIMIT 8`;
          }),
        );
        const observations = yield* inventory
          .refresh(entries, now)
          .pipe(Effect.mapError(() => new C.SpacesUnavailableError({ stage: "storage" })));
        yield* run(environmentId, () =>
          Effect.gen(function* () {
            const sql = yield* SpacesSql.SpacesSql;
            for (const entry of observations) yield* inventory.record(entry);
            const last = entries.at(-1);
            yield* sql`UPDATE spaces_asset_reconciliation SET file_kind = ${last?.kind ?? ""},file_cursor = ${last?.name ?? ""} WHERE singleton = 1`;
          }),
        );
      }
      const accounting = yield* run(environmentId, () =>
        Effect.gen(function* () {
          const usage = yield* Catalog.usage().pipe(assetErrors);
          const current = yield* Reconciliation.state();
          return {
            registeredAssetBytes: usage.physical_bytes,
            reservedBytes: usage.reserved_bytes,
            observedAssetFileBytes: current.assets_bytes,
            observedStagingFileBytes: current.staging_bytes,
            observedAt: current.observed_at_ms,
            reconciliation: yield* Reconciliation.status(),
          };
        }),
      );
      const bytes = (file: string) =>
        fs.stat(file).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.mapError(() => new C.SpacesUnavailableError({ stage: "storage" })),
        );
      return {
        ...accounting,
        databaseBytes: yield* bytes(dbPath),
        walBytes: yield* bytes(`${dbPath}-wal`).pipe(Effect.orElseSucceed(() => 0)),
        sharedMemoryBytes: yield* bytes(`${dbPath}-shm`).pipe(Effect.orElseSucceed(() => 0)),
      };
    }),
  );
  return SpacesService.of({
    maintainAssets,
    createAssetUpload,
    getAssetUpload,
    finalizeAssetUpload,
    getAssetMetadata,
    resolveAssetFile,
    receiveAssetUpload,
    getCapability,
    search,
    listSpaces,
    listPages,
    getPage,
    readBlocks,
    createSpace,
    renameSpace,
    setDefaultSpace,
    createPage,
    updatePage,
    applyBlockBatch,
    lookupMutationReceipt,
    createChildPage,
    movePage,
    inspectStructure,
    moveBlocks,
    resolveReference,
    trashPage,
    restorePage,
    permanentlyDeletePage,
    listTrash,
  });
});

export const layerFromPath = (
  dbPath: string,
  directories?: { readonly assetsDir: string; readonly stagingDir: string },
) => Layer.effect(SpacesService, make(dbPath, directories));
