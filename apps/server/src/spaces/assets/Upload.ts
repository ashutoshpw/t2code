import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
// @effect-diagnostics nodeBuiltinImport:off -- recovery verifies persisted immutable bytes with incremental SHA256 and no-follow descriptors.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { openMediaFile, streamMediaFile } from "../../assets/MediaFile.ts";
import type { Claim } from "./Catalog.ts";
import * as Files from "./Files.ts";
import { fileLimits } from "./Policy.ts";

export class AssetUploadError extends Schema.TaggedError<AssetUploadError>()("AssetUploadError", {
  reason: Schema.Literals([
    "invalid_state",
    "missing_file",
    "corrupt_file",
    "publication_failed",
    "staging_present",
    "io_failed",
  ]),
}) {}
const error = (reason: AssetUploadError["reason"]) => new AssetUploadError({ reason });
const publication = Symbol("SpacesAssetPublication");
const absence = Symbol("SpacesAssetStagingAbsence");
interface PublishedInfo {
  readonly uploadId: string;
  readonly attemptId: string;
  readonly digest: string;
  readonly byteSize: number;
  readonly generation: number;
  readonly separateStaging: boolean;
  readonly path: string;
}
export interface Publication {
  readonly [publication]: PublishedInfo;
}
export interface StagingAbsence {
  readonly [absence]: { readonly uploadId: string; readonly attemptId: string };
}
export const publicationInfo = (proof: Publication) => proof[publication];
export const absenceInfo = (proof: StagingAbsence) => proof[absence];

const verified = Effect.fn("SpacesAssets.verifiedClaim")(function* (claim: Claim) {
  if (
    (claim.state !== "verified" && claim.state !== "ready") ||
    claim.digest === null ||
    !/^[0-9a-f]{64}$/.test(claim.digest) ||
    claim.blob_generation === null ||
    !Number.isSafeInteger(claim.blob_generation) ||
    claim.blob_generation < 0 ||
    !Number.isSafeInteger(claim.expected_bytes) ||
    claim.expected_bytes < 1 ||
    claim.expected_bytes > fileLimits[claim.media_kind] ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(claim.attempt_id)
  )
    return yield* error("invalid_state");
  return { digest: claim.digest, generation: claim.blob_generation };
});
const proofFor = (
  claim: Claim,
  info: { readonly digest: string; readonly generation: number },
  path: string,
  separateStaging: boolean,
): Publication =>
  Object.freeze({
    [publication]: Object.freeze({
      uploadId: claim.upload_id,
      attemptId: claim.attempt_id,
      byteSize: claim.expected_bytes,
      path,
      separateStaging,
      ...info,
    }),
  });
const checkedPath = Effect.fn("SpacesAssets.checkedPath")(function* (
  directory: string,
  name: string,
) {
  const path = yield* Path.Path;
  if (!path.isAbsolute(directory)) return yield* error("invalid_state");
  const fs = yield* FileSystem.FileSystem;
  const normalized = yield* fs.realPath(directory).pipe(
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? fs.realPath(path.dirname(directory)).pipe(
            Effect.map((parent) => path.join(parent, path.basename(directory))),
            Effect.catch((parentCause) =>
              parentCause.reason._tag === "NotFound"
                ? Effect.succeed(directory)
                : Effect.fail(error("io_failed")),
            ),
          )
        : Effect.fail(error("io_failed")),
    ),
  );
  return path.join(normalized, name);
});

export const stage = Effect.fn("SpacesAssets.stageClaim")(function* <E, R>(
  claim: Claim,
  stagingDir: string,
  body: Stream.Stream<Uint8Array, E, R>,
) {
  if (claim.state !== "receiving") return yield* error("invalid_state");
  return yield* Files.stageUpload<E, R>(
    {
      uploadId: claim.attempt_id,
      stagingDir,
      expectedBytes: claim.expected_bytes,
      mediaKind: claim.media_kind,
      mimeType: claim.mime_type,
    },
    body,
  );
});
export const publish = Effect.fn("SpacesAssets.publishClaim")(function* (
  claim: Claim,
  staged: Effect.Success<ReturnType<typeof Files.stageUpload>>,
  assetsDir: string,
) {
  const info = yield* verified(claim);
  if (
    staged.uploadId !== claim.attempt_id ||
    staged.digest !== info.digest ||
    staged.byteSize !== claim.expected_bytes
  )
    return yield* error("invalid_state");
  const result = yield* Files.publishVerified(staged, assetsDir);
  const final = yield* Effect.tryPromise({
    try: () => NodeFSP.lstat(result.path, { bigint: true }),
    catch: () => error("io_failed"),
  });
  return proofFor(
    claim,
    info,
    result.path,
    final.dev !== staged.identity.dev || final.ino !== staged.identity.ino,
  );
});
const inspect = Effect.fn("SpacesAssets.inspectPublication")(function* (
  path: string,
  claim: Claim,
) {
  const info = yield* verified(claim);
  const file = yield* openMediaFile(path).pipe(
    Effect.catch((failure) =>
      failure.cause instanceof Error && "code" in failure.cause && failure.cause.code === "ENOENT"
        ? Effect.void
        : Effect.fail(error("io_failed")),
    ),
  );
  if (file === undefined) return false;
  if (!file || file.info.size !== BigInt(claim.expected_bytes)) return yield* error("corrupt_file");
  const bytes = streamMediaFile(file, 0n, BigInt(claim.expected_bytes));
  if (!bytes) return yield* error("corrupt_file");
  const hash = NodeCrypto.createHash("sha256");
  let count = 0;
  yield* Stream.runForEach(bytes, (chunk) =>
    Effect.sync(() => {
      count += chunk.byteLength;
      hash.update(chunk);
    }),
  ).pipe(Effect.mapError(() => error("io_failed")));
  const after = yield* openMediaFile(path).pipe(Effect.mapError(() => error("io_failed")));
  if (
    !after ||
    count !== claim.expected_bytes ||
    hash.digest("hex") !== info.digest ||
    after.info.ino !== file.info.ino ||
    after.info.dev !== file.info.dev ||
    after.info.size !== file.info.size ||
    after.info.mtimeNs !== file.info.mtimeNs
  )
    return yield* error("corrupt_file");
  return file.info;
});

// Only the shared service may recover an abandoned claim; never race a live receive/publish scope.
export const recoverPublication = Effect.fn("SpacesAssets.recoverPublication")(function* (
  claim: Claim,
  directories: { readonly stagingDir: string; readonly assetsDir: string },
) {
  const info = yield* verified(claim);
  const destination = yield* checkedPath(directories.assetsDir, info.digest);
  const part = yield* checkedPath(directories.stagingDir, `${claim.attempt_id}.part`);
  const final = yield* inspect(destination, claim);
  if (final) {
    const staged = yield* inspect(part, claim);
    return proofFor(
      claim,
      info,
      destination,
      Boolean(staged && (staged.dev !== final.dev || staged.ino !== final.ino)),
    );
  }
  const staged = yield* inspect(part, claim);
  if (!staged) return yield* error("missing_file");
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .makeDirectory(directories.assetsDir, { recursive: true })
    .pipe(Effect.mapError(() => error("publication_failed")));
  yield* fs
    .link(part, destination)
    .pipe(
      Effect.catch((failure) =>
        failure.reason._tag === "AlreadyExists"
          ? Effect.void
          : Effect.fail(error("publication_failed")),
      ),
    );
  const complete = yield* inspect(destination, claim);
  if (!complete) return yield* error("missing_file");
  return proofFor(
    claim,
    info,
    destination,
    staged.dev !== complete.dev || staged.ino !== complete.ino,
  );
}, Effect.scoped);

export const confirmNoStaging = Effect.fn("SpacesAssets.confirmNoStaging")(function* (
  claim: Claim,
  stagingDir: string,
) {
  if (
    (claim.state !== "receiving" && claim.state !== "ready") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(claim.attempt_id)
  )
    return yield* error("invalid_state");
  const part = yield* checkedPath(stagingDir, `${claim.attempt_id}.part`);
  const exists = yield* Effect.tryPromise({
    try: async () => {
      try {
        await NodeFSP.lstat(part);
        return true;
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
        throw cause;
      }
    },
    catch: () => error("io_failed"),
  });
  if (exists) return yield* error("staging_present");
  return Object.freeze({
    [absence]: Object.freeze({ uploadId: claim.upload_id, attemptId: claim.attempt_id }),
  }) satisfies StagingAbsence;
});

const missingPublication = Symbol("SpacesAssetMissingPublication");
export interface MissingPublication {
  readonly [missingPublication]: {
    readonly uploadId: string;
    readonly attemptId: string;
    readonly digest: string;
    readonly generation: number;
  };
}
export const missingPublicationInfo = (proof: MissingPublication) => proof[missingPublication];
export const confirmMissingPublication = Effect.fn("SpacesAssets.confirmMissingPublication")(
  function* (
    claim: Claim,
    directories: { readonly stagingDir: string; readonly assetsDir: string },
  ) {
    const info = yield* verified(claim);
    const part = yield* checkedPath(directories.stagingDir, `${claim.attempt_id}.part`);
    const final = yield* checkedPath(directories.assetsDir, info.digest);
    for (const path of [part, final]) {
      const missing = yield* Effect.tryPromise({
        try: async () => {
          try {
            await NodeFSP.lstat(path);
            return false;
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return true;
            throw cause;
          }
        },
        catch: () => error("io_failed"),
      });
      if (!missing) return yield* error("staging_present");
    }
    return Object.freeze({
      [missingPublication]: Object.freeze({
        uploadId: claim.upload_id,
        attemptId: claim.attempt_id,
        ...info,
      }),
    }) satisfies MissingPublication;
  },
);

// The shared service must establish abandonment before this removes private attempt staging.
export const discardAbandonedStaging = Effect.fn("SpacesAssets.discardAbandonedStaging")(function* (
  claim: Claim,
  directories: { readonly stagingDir: string; readonly assetsDir: string },
  proof?: Publication,
) {
  if (claim.state !== "receiving" && claim.state !== "ready") return yield* error("invalid_state");
  if (claim.state === "ready") {
    if (!proof) return yield* error("invalid_state");
    const published = publicationInfo(proof);
    if (
      published.uploadId !== claim.upload_id ||
      published.attemptId !== claim.attempt_id ||
      published.digest !== claim.digest ||
      published.generation !== claim.blob_generation
    )
      return yield* error("invalid_state");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(claim.attempt_id)
  )
    return yield* error("invalid_state");
  const part = yield* checkedPath(directories.stagingDir, `${claim.attempt_id}.part`);
  const file = yield* openMediaFile(part).pipe(
    Effect.catch((failure) =>
      failure.cause instanceof Error && "code" in failure.cause && failure.cause.code === "ENOENT"
        ? Effect.void
        : Effect.fail(error("io_failed")),
    ),
  );
  if (file === null) return yield* error("corrupt_file");
  if (file)
    yield* Effect.tryPromise({
      try: async () => {
        const current = await NodeFSP.lstat(part, { bigint: true });
        if (current.dev !== file.info.dev || current.ino !== file.info.ino)
          throw new Error("Staging changed");
        await NodeFSP.unlink(part);
      },
      catch: () => error("io_failed"),
    });
  return yield* confirmNoStaging(claim, directories.stagingDir);
}, Effect.scoped);
