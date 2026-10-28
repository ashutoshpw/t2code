// @effect-diagnostics nodeBuiltinImport:off -- exclusive handles and inode checks keep cleanup and publication tied to owned files.
import * as NodeCrypto from "node:crypto";
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import { readImageDimensions, type ImageDimensions } from "@t2code/shared/imageDimensions";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { openMediaFile, streamMediaFile } from "../../assets/MediaFile.ts";
import { fileLimits, mediaTypes, type MediaKind, type MediaType } from "./Policy.ts";

export class AssetFileError extends Schema.TaggedError<AssetFileError>()("AssetFileError", {
  reason: Schema.Literals([
    "invalid_reservation",
    "staging_exists",
    "size_mismatch",
    "unsupported_content",
    "media_mismatch",
    "image_dimensions",
    "image_pixels",
    "source_failed",
    "staging_changed",
    "destination_conflict",
    "publication_failed",
    "io_failed",
  ]),
}) {}

const uploadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const isAssetFileError = Schema.is(AssetFileError);
const failure = (reason: AssetFileError["reason"]) => new AssetFileError({ reason });
const io = <A>(use: () => Promise<A>) =>
  Effect.tryPromise({ try: use, catch: () => failure("io_failed") });

function text(bytes: Uint8Array, start: number, end: number) {
  return new TextDecoder().decode(bytes.subarray(start, end));
}
function starts(bytes: Uint8Array, signature: readonly number[], offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function jpegHeader(bytes: Uint8Array) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 2; offset + 4 <= bytes.length;) {
    if (bytes[offset] !== 0xff) return false;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = data.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return length >= 8;
    offset += 2 + length;
  }
  return false;
}

function webpHeader(bytes: Uint8Array, byteSize: number) {
  if (bytes.length < 25 || text(bytes, 0, 4) !== "RIFF" || text(bytes, 8, 12) !== "WEBP")
    return false;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.getUint32(4, true) + 8 !== byteSize) return false;
  const size = data.getUint32(16, true);
  if (20 + size + (size % 2) > byteSize) return false;
  switch (text(bytes, 12, 16)) {
    case "VP8 ":
      return bytes.length >= 30 && size >= 10 && starts(bytes, [0x9d, 1, 0x2a], 23);
    case "VP8L":
      return size >= 5 && bytes[20] === 0x2f;
    case "VP8X":
      return bytes.length >= 30 && size === 10;
    default:
      return false;
  }
}

function mp4Header(bytes: Uint8Array) {
  if (bytes.length < 16 || text(bytes, 4, 8) !== "ftyp") return false;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (size < 16 || size > bytes.length || size % 4 !== 0) return false;
  return ["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V "].includes(
    text(bytes, 8, 12),
  );
}

function vint(bytes: Uint8Array, offset: number, id: boolean) {
  const first = bytes[offset];
  if (!first) return null;
  let mask = 0x80;
  let length = 1;
  while (!(first & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > (id ? 4 : 8) || offset + length > bytes.length) return null;
  let value = id ? first : first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i]!;
  if (!Number.isSafeInteger(value) || (!id && value === 2 ** (7 * length) - 1)) return null;
  return { value, end: offset + length };
}

function webmHeader(bytes: Uint8Array) {
  if (!starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return false;
  const size = vint(bytes, 4, false);
  if (!size || size.end + size.value > bytes.length) return false;
  const end = size.end + size.value;
  let webm = false;
  for (let offset = size.end; offset < end;) {
    const id = vint(bytes, offset, true);
    const length = id && vint(bytes, id.end, false);
    if (!id || !length || length.end + length.value > end) return false;
    if (id.value === 0x4282) {
      if (webm || text(bytes, length.end, length.end + length.value) !== "webm") return false;
      webm = true;
    }
    offset = length.end + length.value;
  }
  return webm;
}

function inspect(bytes: Uint8Array, byteSize: number) {
  let mimeType: MediaType;
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])) {
    if (
      bytes.length < 33 ||
      text(bytes, 12, 16) !== "IHDR" ||
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8) !== 13
    )
      throw failure("unsupported_content");
    mimeType = "image/png";
  } else if (text(bytes, 0, 6) === "GIF87a" || text(bytes, 0, 6) === "GIF89a") {
    if (bytes.length < 13) throw failure("unsupported_content");
    mimeType = "image/gif";
  } else if (starts(bytes, [0xff, 0xd8, 0xff])) {
    if (!jpegHeader(bytes)) throw failure("unsupported_content");
    mimeType = "image/jpeg";
  } else if (webpHeader(bytes, byteSize)) mimeType = "image/webp";
  else if (/^%PDF-[12]\.[0-9]/.test(text(bytes, 0, 8))) mimeType = "application/pdf";
  else if (mp4Header(bytes)) mimeType = "video/mp4";
  else if (webmHeader(bytes)) mimeType = "video/webm";
  else throw failure("unsupported_content");
  const mediaKind = mediaTypes[mimeType];
  let imageDimensions: ImageDimensions | undefined;
  if (mediaKind === "image") {
    imageDimensions = readImageDimensions(bytes) ?? undefined;
    if (!imageDimensions) throw failure("image_dimensions");
    if (imageDimensions.width * imageDimensions.height > fileLimits.imagePixels)
      throw failure("image_pixels");
  }
  return { mimeType, mediaKind, ...(imageDimensions ? { imageDimensions } : {}) };
}

interface StagedFile {
  readonly uploadId: string;
  readonly partPath: string;
  readonly digest: string;
  readonly byteSize: number;
  readonly mimeType: MediaType;
  readonly mediaKind: MediaKind;
  readonly imageDimensions?: ImageDimensions;
  readonly identity: { readonly dev: bigint; readonly ino: bigint; readonly mtimeNs: bigint };
  readonly release: Effect.Effect<void, AssetFileError>;
}

const releaseOwned = Effect.fn("SpacesAssets.releaseStaged")(function* (
  partPath: string,
  file: { readonly handle: NodeFSP.FileHandle; readonly info: NodeFS.BigIntStats },
  ownership: { retired: boolean; readonly mutex: Semaphore.Semaphore },
) {
  yield* ownership.mutex.withPermit(
    Effect.gen(function* () {
      if (ownership.retired) return;
      yield* io(async () => {
        await file.handle.close();
        const current = await NodeFSP.lstat(partPath, { bigint: true }).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        });
        if (current?.isFile() && current.dev === file.info.dev && current.ino === file.info.ino)
          await NodeFSP.unlink(partPath);
      });
      // The inode can be reused immediately after unlink; every later cleanup must stay retired.
      ownership.retired = true;
    }),
  );
}, Effect.uninterruptible);

export const stageUpload = Effect.fn("SpacesAssets.stageUpload")(function* <
  E,
  R,
  E2 = never,
  R2 = never,
>(
  input: {
    readonly uploadId: string;
    readonly stagingDir: string;
    readonly expectedBytes: number;
    readonly mediaKind: MediaKind;
    readonly mimeType: MediaType;
  },
  body: Stream.Stream<Uint8Array, E, R>,
  onCreated?: (identity: {
    readonly dev: string;
    readonly ino: string;
    readonly birthtimeNs: string;
  }) => Effect.Effect<void, E2, R2>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    !uploadIdPattern.test(input.uploadId) ||
    !path.isAbsolute(input.stagingDir) ||
    !Object.hasOwn(mediaTypes, input.mimeType) ||
    mediaTypes[input.mimeType] !== input.mediaKind ||
    !Number.isSafeInteger(input.expectedBytes) ||
    input.expectedBytes < 1 ||
    input.expectedBytes > fileLimits[input.mediaKind]
  )
    return yield* failure("invalid_reservation");
  yield* fs
    .makeDirectory(input.stagingDir, { recursive: true })
    .pipe(Effect.mapError(() => failure("io_failed")));
  const directory = yield* fs
    .realPath(input.stagingDir)
    .pipe(Effect.mapError(() => failure("io_failed")));
  const partPath = path.join(directory, `${input.uploadId}.part`);
  const ownership = { retired: false, mutex: yield* Semaphore.make(1) };
  const owned = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const handle = await NodeFSP.open(partPath, "wx", 0o600);
        try {
          const info = await handle.stat({ bigint: true });
          return { handle, info };
        } catch (cause) {
          await handle.close();
          throw cause;
        }
      },
      catch: (cause) =>
        failure(
          cause instanceof Error && "code" in cause && cause.code === "EEXIST"
            ? "staging_exists"
            : "io_failed",
        ),
    }),
    (file) =>
      releaseOwned(partPath, file, ownership).pipe(
        Effect.catch(() => Effect.logWarning("Failed to release a staged Spaces asset.")),
      ),
  );
  const release = releaseOwned(partPath, owned, ownership);
  if (onCreated)
    yield* onCreated({
      dev: owned.info.dev.toString(),
      ino: owned.info.ino.toString(),
      birthtimeNs: owned.info.birthtimeNs.toString(),
    });
  return yield* Effect.gen(function* () {
    const hash = NodeCrypto.createHash("sha256");
    const header = new Uint8Array(Math.min(fileLimits.headerBytes, input.expectedBytes));
    let received = 0;
    // Streaming work shares the upload span; each write finishes before another chunk is pulled.
    yield* Stream.runForEach(body.pipe(Stream.mapError(() => failure("source_failed"))), (chunk) =>
      Effect.gen(function* () {
        if (chunk.byteLength > input.expectedBytes - received)
          return yield* failure("size_mismatch");
        if (received < header.length)
          header.set(chunk.subarray(0, header.length - received), received);
        yield* io(async () => {
          let offset = 0;
          while (offset < chunk.byteLength) {
            const written = await owned.handle.write(chunk, offset, chunk.byteLength - offset);
            if (written.bytesWritten === 0) throw new Error("Zero-byte write");
            offset += written.bytesWritten;
          }
        });
        hash.update(chunk);
        received += chunk.byteLength;
      }),
    );
    if (received !== input.expectedBytes) return yield* failure("size_mismatch");
    const media = yield* Effect.try({
      try: () => inspect(header, received),
      catch: (cause) => (isAssetFileError(cause) ? cause : failure("unsupported_content")),
    });
    if (media.mimeType !== input.mimeType || media.mediaKind !== input.mediaKind)
      return yield* failure("media_mismatch");
    yield* io(() => owned.handle.sync());
    const identity = yield* io(() => owned.handle.stat({ bigint: true }));
    yield* io(() => owned.handle.close());
    return {
      uploadId: input.uploadId,
      partPath,
      digest: hash.digest("hex"),
      byteSize: received,
      ...media,
      identity: { dev: identity.dev, ino: identity.ino, mtimeNs: identity.mtimeNs },
      release,
    } satisfies StagedFile;
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? release.pipe(
            Effect.catch(() => Effect.logWarning("Failed to release a staged Spaces asset.")),
          )
        : Effect.void,
    ),
  );
});

export const publishVerified = Effect.fn("SpacesAssets.publishVerified")(function* (
  staged: StagedFile,
  assetsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    !uploadIdPattern.test(staged.uploadId) ||
    !digestPattern.test(staged.digest) ||
    !path.isAbsolute(assetsDir) ||
    !path.isAbsolute(staged.partPath) ||
    path.basename(staged.partPath) !== `${staged.uploadId}.part` ||
    !Number.isSafeInteger(staged.byteSize) ||
    staged.byteSize < 1 ||
    !Object.hasOwn(mediaTypes, staged.mimeType) ||
    mediaTypes[staged.mimeType] !== staged.mediaKind ||
    staged.byteSize > fileLimits[staged.mediaKind]
  )
    return yield* failure("invalid_reservation");
  const source = yield* openMediaFile(staged.partPath).pipe(
    Effect.mapError(() => failure("staging_changed")),
  );
  if (
    !source ||
    source.info.dev !== staged.identity.dev ||
    source.info.ino !== staged.identity.ino ||
    source.info.mtimeNs !== staged.identity.mtimeNs ||
    source.info.size !== BigInt(staged.byteSize)
  )
    return yield* failure("staging_changed");
  yield* fs
    .makeDirectory(assetsDir, { recursive: true })
    .pipe(Effect.mapError(() => failure("publication_failed")));
  const directory = yield* fs
    .realPath(assetsDir)
    .pipe(Effect.mapError(() => failure("publication_failed")));
  const finalPath = path.join(directory, staged.digest);
  yield* fs
    .link(staged.partPath, finalPath)
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "AlreadyExists"
          ? Effect.void
          : Effect.fail(failure("publication_failed")),
      ),
    );
  const destination = yield* openMediaFile(finalPath).pipe(
    Effect.mapError(() => failure("destination_conflict")),
  );
  if (!destination || destination.info.size !== BigInt(staged.byteSize))
    return yield* failure("destination_conflict");
  if (destination.info.dev !== source.info.dev || destination.info.ino !== source.info.ino) {
    const stream = streamMediaFile(destination, 0n, BigInt(staged.byteSize));
    if (!stream) return yield* failure("destination_conflict");
    const hash = NodeCrypto.createHash("sha256");
    let received = 0;
    yield* Stream.runForEach(stream, (chunk) =>
      Effect.sync(() => {
        received += chunk.byteLength;
        hash.update(chunk);
      }),
    ).pipe(Effect.mapError(() => failure("destination_conflict")));
    const after = yield* openMediaFile(finalPath).pipe(
      Effect.mapError(() => failure("destination_conflict")),
    );
    if (
      received !== staged.byteSize ||
      hash.digest("hex") !== staged.digest ||
      !after ||
      after.info.dev !== destination.info.dev ||
      after.info.ino !== destination.info.ino ||
      after.info.size !== destination.info.size ||
      after.info.mtimeNs !== destination.info.mtimeNs
    )
      return yield* failure("destination_conflict");
  }
  return { path: finalPath, digest: staged.digest, byteSize: staged.byteSize };
}, Effect.scoped);
