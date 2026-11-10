import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { openMediaFile } from "../../assets/MediaFile.ts";
import * as Catalog from "../assets/Catalog.ts";
import * as Upload from "../assets/Upload.ts";
import * as Tokens from "../assets/Tokens.ts";
import { byteLength, canonical, ensureLimit, limits } from "../CorePolicy.ts";
import * as SpacesSql from "../SpacesSql.ts";
import {
  strict,
  decodeAssetCreate,
  decodeAssetUpload,
  decodeAssetGet,
  assetErrors,
  metadata,
  claimFrom,
  isServiceError,
  validateRaw,
  cursorFor,
  cursorFrom,
  decodeAssetCursor,
  assetMetadata,
} from "./Helpers.ts";
import type { Runtime } from "./Runtime.ts";

export const make = (rt: Runtime) => {
  const {
    platform,
    fs,
    path,
    assetDirectories,
    activeUploads,
    collectionOwner,
    recover,
    acquire,
    admit,
    checkEnvironment,
    run,
    read,
    leaseUpload,
    releaseUpload,
  } = rt;
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
    const row = yield* read(environmentId, () =>
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
    const row = yield* read(environmentId, () =>
      Catalog.readyAsset(input.assetId).pipe(assetErrors),
    );
    return assetMetadata(row);
  });
  const resolveAssetFile = Effect.fn("SpacesService.resolveAssetFile")(function* (raw: unknown) {
    return yield* openAssetFile(yield* getAssetMetadata(raw));
  });
  const openAssetFile = Effect.fn("SpacesService.openAssetFile")(function* (
    asset: ReturnType<typeof assetMetadata>,
  ) {
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
      () => releaseUpload(input.uploadId),
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
              return yield* Catalog.claim(
                grant.callerId,
                grant.uploadId,
                meta.observed_time_ms,
                collectionOwner,
              );
            }).pipe(assetErrors),
          );
          let verified = false;
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const staged = yield* Upload.stage(
                claim,
                assetDirectories.stagingDir,
                body,
                (identity) =>
                  run(environmentId, () =>
                    Catalog.recordCreated(claim, identity).pipe(assetErrors),
                  ),
              ).pipe(assetErrors);
              const accepted = yield* run(environmentId, (meta) =>
                Catalog.recordVerified(claim, staged, meta.observed_time_ms).pipe(assetErrors),
              );
              verified = true;
              const proof = yield* Upload.publish(
                accepted,
                staged,
                assetDirectories.assetsDir,
              ).pipe(assetErrors, Effect.uninterruptible);
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
      () => releaseUpload(grant.uploadId),
    );
  });
  const listAssets = Effect.fn("SpacesService.listAssets")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(C.SpaceAssetListInput, strict)),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* read(environmentId, (meta) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        const limit = input.limit ?? limits.maxListRows;
        yield* ensureLimit("maxListRows", limit);
        const filter = canonical({ mediaType: input.mediaType ?? null });
        const cursor = yield* cursorFrom(
          input.cursor,
          environmentId,
          "listAssets",
          filter,
          meta.catalog_revision,
        );
        const [assetId, pageId] = cursor ? yield* decodeAssetCursor(cursor) : ["", ""];
        const after = cursor
          ? sql`AND (a.created_at_ms < ${Number(cursor.key)} OR (a.created_at_ms = ${Number(cursor.key)} AND (a.asset_id,p.page_id) > (${assetId},${pageId})))`
          : sql``;
        const media = input.mediaType ? sql`AND b.media_kind = ${input.mediaType}` : sql``;
        const rows = yield* sql<{
          readonly asset_id: C.SpaceAssetId;
          readonly name: string;
          readonly mime_type: C.SpaceAssetMetadata["mimeType"];
          readonly byte_size: number;
          readonly created_at_ms: number;
          readonly page_id: C.SpacePageId;
          readonly space_id: C.SpaceId;
        }>`
        SELECT DISTINCT a.asset_id,a.name,b.mime_type,b.byte_size,a.created_at_ms,p.page_id,p.space_id
        FROM spaces_assets a JOIN spaces_asset_blobs b ON b.digest=a.digest
        JOIN spaces_block_asset_refs r ON r.asset_id=a.asset_id
        JOIN spaces_blocks block ON block.block_id=r.block_id
        JOIN spaces_pages p ON p.page_id=block.page_id
        WHERE a.state='ready' AND b.state='ready' AND block.deleted=0 AND p.trash_batch_id IS NULL
          AND COALESCE(a.blob_generation,(SELECT u.blob_generation FROM spaces_asset_uploads u WHERE u.asset_id=a.asset_id AND u.digest=a.digest AND u.state='ready'))=b.generation
          ${media} ${after}
        ORDER BY a.created_at_ms DESC,a.asset_id,p.page_id LIMIT ${limit + 1}`;
        let take = Math.min(limit, rows.length);
        while (true) {
          const last = rows[take - 1];
          const result: C.SpaceAssetListResult = {
            items: rows.slice(0, take).map((row) => ({
              assetId: row.asset_id,
              name: row.name,
              mimeType: row.mime_type,
              byteSize: row.byte_size,
              createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.created_at_ms)),
              pageId: row.page_id,
              spaceId: row.space_id,
            })),
            catalogRevision: meta.catalog_revision,
            nextCursor:
              take < rows.length && last
                ? yield* cursorFor(
                    environmentId,
                    "listAssets",
                    filter,
                    meta.catalog_revision,
                    String(last.created_at_ms),
                    canonical([last.asset_id, last.page_id]),
                  )
                : null,
          };
          const size = byteLength(result);
          if (size <= limits.maxListResponseBytes) return result;
          if (take <= 1) yield* ensureLimit("maxListResponseBytes", size);
          take--;
        }
      }),
    );
  });
  return {
    createAssetUpload,
    getAssetUpload,
    getAssetMetadata,
    resolveAssetFile,
    openAssetFile,
    finalizeAssetUpload,
    receiveAssetUpload,
    listAssets,
  };
};

export type Assets = ReturnType<typeof make>;
