// @effect-diagnostics nodeBuiltinImport:off -- fixtures keep real descriptors open across unlink and use independent SHA256 checks.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";

import { publishVerified, stageUpload } from "./Files.ts";
import { fileLimits, type MediaKind, type MediaType } from "./Policy.ts";

const encode = (value: string) => new TextEncoder().encode(value);
const pdf = encode("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  ),
);
const gif = new Uint8Array(
  Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
);
function jpeg(metadataBytes = 0) {
  const frame = new Uint8Array([0xff, 0xc0, 0, 11, 8, 0, 100, 0, 200, 1, 1, 0x11, 0]);
  const bytes = new Uint8Array(2 + (metadataBytes ? metadataBytes + 4 : 0) + frame.length);
  bytes.set([0xff, 0xd8]);
  if (metadataBytes) {
    bytes.set([0xff, 0xe1], 2);
    new DataView(bytes.buffer).setUint16(4, metadataBytes + 2);
  }
  bytes.set(frame, bytes.length - frame.length);
  return bytes;
}
function webp(chunk: "VP8 " | "VP8L" | "VP8X") {
  const bytes = new Uint8Array(chunk === "VP8L" ? 26 : 30);
  bytes.set(encode("RIFF"));
  bytes.set(encode(`WEBP${chunk}`), 8);
  const data = new DataView(bytes.buffer);
  data.setUint32(4, bytes.length - 8, true);
  data.setUint32(16, chunk === "VP8L" ? 5 : 10, true);
  if (chunk === "VP8 ") {
    bytes.set([0x9d, 1, 0x2a], 23);
    data.setUint16(26, 200, true);
    data.setUint16(28, 100, true);
  } else if (chunk === "VP8L") {
    bytes[20] = 0x2f;
    data.setUint32(21, 199 | (99 << 14), true);
  } else {
    bytes[24] = 199;
    bytes[27] = 99;
  }
  return bytes;
}
const mp4 = new Uint8Array([0, 0, 0, 24, ...encode("ftypisom"), 0, 0, 2, 0, ...encode("isommp42")]);
const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, ...encode("webm")]);

const fixture = Effect.fn("AssetsFilesTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t2-spaces-assets-files-" });
  return { fs, path, stagingDir: path.join(root, "staging"), assetsDir: path.join(root, "assets") };
});
function reservation(
  stagingDir: string,
  expectedBytes = pdf.length,
  mediaKind: MediaKind = "pdf",
  mimeType: MediaType = "application/pdf",
) {
  return { uploadId: NodeCrypto.randomUUID(), stagingDir, expectedBytes, mediaKind, mimeType };
}

// This boundary owns byte integrity and file lifetime; HTTP framing and catalog readiness have different owners.
describe("Spaces asset files", () => {
  it.effect("identifies split supported headers, dimensions, and exact streamed SHA256", () =>
    Effect.gen(function* () {
      const { fs, stagingDir } = yield* fixture();
      for (const [bytes, mediaKind, mimeType, dimensions] of [
        [png, "image", "image/png", { width: 1, height: 1 }],
        [gif, "image", "image/gif", { width: 1, height: 1 }],
        [jpeg(), "image", "image/jpeg", { width: 200, height: 100 }],
        [webp("VP8 "), "image", "image/webp", { width: 200, height: 100 }],
        [webp("VP8L"), "image", "image/webp", { width: 200, height: 100 }],
        [webp("VP8X"), "image", "image/webp", { width: 200, height: 100 }],
        [pdf, "pdf", "application/pdf", undefined],
        [mp4, "video", "video/mp4", undefined],
        [webm, "video", "video/webm", undefined],
      ] as const) {
        const staged = yield* stageUpload(
          reservation(stagingDir, bytes.length, mediaKind, mimeType),
          Stream.fromIterable(Array.from(bytes, (byte) => new Uint8Array([byte]))),
        );
        expect(staged).toMatchObject({
          byteSize: bytes.length,
          mediaKind,
          mimeType,
          digest: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        });
        expect(staged.imageDimensions).toEqual(dimensions);
        expect(new Uint8Array(yield* fs.readFile(staged.partPath))).toEqual(bytes);
        yield* staged.release;
        yield* staged.release;
      }
      expect(yield* fs.readDirectory(stagingDir)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses unsupported, misleading and incomplete content without leaving a part", () =>
    Effect.gen(function* () {
      const { fs, stagingDir } = yield* fixture();
      const avif = mp4.slice();
      avif.set(encode("avif"), 8);
      const matroska = webm.slice();
      matroska.set(encode("mkv!"), 8);
      const malformedWebp = webp("VP8 ");
      malformedWebp[23] = 0;
      for (const [bytes, mediaKind, mimeType, reason] of [
        [png, "pdf", "application/pdf", "media_mismatch"],
        [pdf, "image", "image/png", "media_mismatch"],
        [
          encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
          "image",
          "image/png",
          "unsupported_content",
        ],
        [
          encode("<html><body>image.png</body></html>"),
          "pdf",
          "application/pdf",
          "unsupported_content",
        ],
        [avif, "video", "video/mp4", "unsupported_content"],
        [matroska, "video", "video/webm", "unsupported_content"],
        [malformedWebp, "image", "image/webp", "unsupported_content"],
        [png.subarray(0, 24), "image", "image/png", "unsupported_content"],
      ] as const) {
        expect(
          yield* stageUpload(
            reservation(stagingDir, bytes.length, mediaKind, mimeType),
            Stream.make(bytes),
          ).pipe(Effect.flip),
        ).toMatchObject({ _tag: "AssetFileError", reason });
        expect(yield* fs.readDirectory(stagingDir)).toEqual([]);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds dimension discovery to 64KiB and rejects zero or over-budget dimensions", () =>
    Effect.gen(function* () {
      const { fs, stagingDir } = yield* fixture();
      const exactHeader = jpeg(fileLimits.headerBytes - 19);
      expect(exactHeader.length).toBe(65_536);
      const accepted = yield* stageUpload(
        reservation(stagingDir, exactHeader.length, "image", "image/jpeg"),
        Stream.make(exactHeader.subarray(0, 65530), exactHeader.subarray(65530)),
      );
      expect(accepted.imageDimensions).toEqual({ width: 200, height: 100 });
      yield* accepted.release;
      const beyondHeader = jpeg(fileLimits.headerBytes - 18);
      expect(
        yield* stageUpload(
          reservation(stagingDir, beyondHeader.length, "image", "image/jpeg"),
          Stream.make(beyondHeader),
        ).pipe(Effect.flip),
      ).toMatchObject({ reason: "unsupported_content" });
      for (const [width, height, reason] of [
        [6000, 4000, undefined],
        [6001, 4000, "image_pixels"],
        [0, 1, "image_dimensions"],
      ] as const) {
        const bytes = png.slice();
        const data = new DataView(bytes.buffer);
        data.setUint32(16, width);
        data.setUint32(20, height);
        const result = yield* stageUpload(
          reservation(stagingDir, bytes.length, "image", "image/png"),
          Stream.make(bytes),
        ).pipe(Effect.result);
        if (reason) expect(result).toMatchObject({ _tag: "Failure", failure: { reason } });
        else {
          expect(result._tag).toBe("Success");
          if (result._tag === "Success") {
            expect(result.success.imageDimensions).toEqual({ width, height });
            yield* result.success.release;
          }
        }
      }
      expect(yield* fs.readDirectory(stagingDir)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("admits each byte cap exactly and refuses larger reservations before reading", () =>
    Effect.gen(function* () {
      const { fs, stagingDir } = yield* fixture();
      for (const [mediaKind, mimeType, header, maximum] of [
        ["image", "image/png", png, 10 * 1024 * 1024],
        ["pdf", "application/pdf", pdf, 25 * 1024 * 1024],
        ["video", "video/mp4", mp4, 50 * 1024 * 1024],
      ] as const) {
        const fill = new Uint8Array(64 * 1024);
        const body = Stream.make(header).pipe(
          Stream.concat(
            Stream.fromIterable(
              (function* () {
                for (
                  let remaining = maximum - header.length;
                  remaining > 0;
                  remaining -= fill.length
                )
                  yield fill.subarray(0, Math.min(remaining, fill.length));
              })(),
            ),
          ),
        );
        const staged = yield* stageUpload(
          reservation(stagingDir, maximum, mediaKind, mimeType),
          body,
        );
        expect(staged.byteSize).toBe(maximum);
        expect((yield* fs.stat(staged.partPath)).size).toBe(BigInt(maximum));
        yield* staged.release;
        let pulled = false;
        const tooLarge = yield* stageUpload(
          reservation(stagingDir, maximum + 1, mediaKind, mimeType),
          Stream.fromEffect(
            Effect.sync(() => {
              pulled = true;
              return header;
            }),
          ),
        ).pipe(Effect.flip);
        expect(tooLarge).toMatchObject({ reason: "invalid_reservation" });
        expect(pulled).toBe(false);
      }
      expect(yield* fs.readDirectory(stagingDir)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "cleans short, failed and interrupted streams while their caller scope remains open",
    () =>
      Effect.gen(function* () {
        const { fs, stagingDir } = yield* fixture();
        for (const [body, reason] of [
          [Stream.make(pdf.subarray(0, pdf.length - 1)), "size_mismatch"],
          [
            Stream.make(pdf.subarray(0, 8)).pipe(Stream.concat(Stream.fail("network failed"))),
            "source_failed",
          ],
        ] as const) {
          expect(yield* stageUpload(reservation(stagingDir), body).pipe(Effect.flip)).toMatchObject(
            { reason },
          );
          expect(yield* fs.readDirectory(stagingDir)).toEqual([]);
        }
        const requested = yield* Deferred.make<void>();
        const body = Stream.make(pdf.subarray(0, 8)).pipe(
          Stream.concat(
            Stream.fromEffect(
              Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          ),
        );
        const upload = yield* stageUpload(reservation(stagingDir), body).pipe(Effect.forkScoped);
        yield* Deferred.await(requested);
        expect(yield* fs.readDirectory(stagingDir)).toHaveLength(1);
        yield* Fiber.interrupt(upload);
        expect(yield* fs.readDirectory(stagingDir)).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects overflow before writing that chunk and stops pulling the source", () =>
    Effect.gen(function* () {
      const { fs, path, stagingDir } = yield* fixture();
      const input = reservation(stagingDir);
      const requested = yield* Deferred.make<void>();
      const overflow = yield* Deferred.make<Uint8Array>();
      let pulledAfterOverflow = false;
      const body = Stream.make(pdf).pipe(
        Stream.concat(
          Stream.fromEffect(
            Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(overflow))),
          ),
        ),
        Stream.concat(
          Stream.fromEffect(
            Effect.sync(() => {
              pulledAfterOverflow = true;
              return pdf;
            }),
          ),
        ),
      );
      const upload = yield* stageUpload(input, body).pipe(Effect.forkScoped);
      yield* Deferred.await(requested);
      const handle = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.open(path.join(stagingDir, `${input.uploadId}.part`), "r")),
        (file) => Effect.promise(() => file.close()),
      );
      yield* Deferred.succeed(overflow, new Uint8Array([42]));
      expect(yield* Fiber.join(upload).pipe(Effect.flip)).toMatchObject({
        reason: "size_mismatch",
      });
      expect(new Uint8Array(yield* Effect.promise(() => handle.readFile()))).toEqual(pdf);
      expect(pulledAfterOverflow).toBe(false);
      expect(yield* fs.readDirectory(stagingDir)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never removes a preexisting part or a replacement it does not own", () =>
    Effect.gen(function* () {
      const { fs, path, stagingDir } = yield* fixture();
      yield* fs.makeDirectory(stagingDir);
      const input = reservation(stagingDir);
      const partPath = path.join(stagingDir, `${input.uploadId}.part`);
      yield* fs.writeFileString(partPath, "another attempt");
      expect(yield* stageUpload(input, Stream.make(pdf)).pipe(Effect.flip)).toMatchObject({
        reason: "staging_exists",
      });
      expect(yield* fs.readFileString(partPath)).toBe("another attempt");
      const staged = yield* stageUpload(reservation(stagingDir), Stream.make(pdf));
      // Rename preserves the old inode so the replacement cannot reuse it.
      yield* fs.rename(staged.partPath, `${staged.partPath}.old`);
      yield* fs.writeFileString(staged.partPath, "replacement");
      yield* staged.release;
      expect(yield* fs.readFileString(staged.partPath)).toBe("replacement");
      yield* fs.remove(staged.partPath);
      yield* fs.rename(`${staged.partPath}.old`, staged.partPath);
      yield* staged.release;
      expect(new Uint8Array(yield* fs.readFile(staged.partPath))).toEqual(pdf);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    ["retry", "explicit"],
    ["retry", "scope"],
    ["same-inode link", "explicit"],
    ["same-inode link", "scope"],
  ] as const)("retires old cleanup before %s reuse and later %s release", ([reuse, cleanup]) =>
    Effect.gen(function* () {
      const { fs, stagingDir, assetsDir } = yield* fixture();
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
      const input = reservation(stagingDir);
      const first = yield* stageUpload(input, Stream.make(pdf)).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const published =
        reuse === "same-inode link" ? yield* publishVerified(first, assetsDir) : undefined;
      yield* first.release;
      const second = yield* stageUpload(input, Stream.make(pdf));
      if (published) {
        yield* second.release;
        // A real hard link deterministically reuses the retired inode at a new directory entry.
        yield* fs.link(published.path, second.partPath);
        const info = yield* Effect.promise(() => NodeFSP.lstat(second.partPath, { bigint: true }));
        expect(info.ino).toBe(first.identity.ino);
      }
      if (cleanup === "explicit") yield* first.release;
      else yield* Scope.close(scope, Exit.void);
      expect(
        yield* fs.exists(second.partPath),
        `first inode=${first.identity.ino}; retry inode=${second.identity.ino}; reuse=${reuse}`,
      ).toBe(true);
      expect(new Uint8Array(yield* fs.readFile(second.partPath))).toEqual(pdf);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retries failed cleanup and serializes explicit release with scope finalization", () =>
    Effect.gen(function* () {
      const { fs, stagingDir, assetsDir } = yield* fixture();
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
      const staged = yield* stageUpload(reservation(stagingDir), Stream.make(pdf)).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const published = yield* publishVerified(staged, assetsDir);
      const heldDirectory = `${stagingDir}-held`;
      yield* fs.rename(stagingDir, heldDirectory);
      yield* fs.writeFileString(stagingDir, "blocks path inspection");
      expect(yield* staged.release.pipe(Effect.flip)).toMatchObject({ reason: "io_failed" });
      yield* fs.remove(stagingDir);
      yield* fs.rename(heldDirectory, stagingDir);
      expect(yield* fs.exists(staged.partPath)).toBe(true);
      yield* Effect.all([staged.release, Scope.close(scope, Exit.void), staged.release], {
        concurrency: "unbounded",
      });
      expect(yield* fs.exists(staged.partPath)).toBe(false);
      yield* fs.link(published.path, staged.partPath);
      yield* staged.release;
      expect(new Uint8Array(yield* fs.readFile(staged.partPath))).toEqual(pdf);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "retires failure cleanup before its stale scope finalizer can remove a reused inode",
    () =>
      Effect.gen(function* () {
        const { fs, path, stagingDir } = yield* fixture();
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
        const input = reservation(stagingDir);
        const partPath = path.join(stagingDir, `${input.uploadId}.part`);
        const heldPath = `${partPath}.held`;
        const body = Stream.make(pdf.subarray(0, 8)).pipe(
          Stream.concat(
            Stream.fromEffect(
              fs.link(partPath, heldPath).pipe(Effect.andThen(Effect.fail("disconnected"))),
            ),
          ),
        );
        expect(
          yield* stageUpload(input, body).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.flip,
          ),
        ).toMatchObject({ reason: "source_failed" });
        expect(yield* fs.exists(partPath)).toBe(false);
        yield* fs.rename(heldPath, partPath);
        yield* Scope.close(scope, Exit.void);
        expect(new Uint8Array(yield* fs.readFile(partPath))).toEqual(pdf.subarray(0, 8));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps the public digest absent until staging completes and retains the part through publication",
    () =>
      Effect.gen(function* () {
        const { fs, path, stagingDir, assetsDir } = yield* fixture();
        yield* fs.makeDirectory(assetsDir);
        const digest = NodeCrypto.createHash("sha256").update(pdf).digest("hex");
        const finalPath = path.join(assetsDir, digest);
        const requested = yield* Deferred.make<void>();
        const remainder = yield* Deferred.make<Uint8Array>();
        const body = Stream.make(pdf.subarray(0, 8)).pipe(
          Stream.concat(
            Stream.fromEffect(
              Deferred.succeed(requested, undefined).pipe(
                Effect.andThen(Deferred.await(remainder)),
              ),
            ),
          ),
        );
        const upload = yield* stageUpload(reservation(stagingDir), body).pipe(Effect.forkScoped);
        yield* Deferred.await(requested);
        expect(yield* fs.exists(finalPath)).toBe(false);
        yield* Deferred.succeed(remainder, pdf.subarray(8));
        const staged = yield* Fiber.join(upload);
        expect(yield* fs.exists(finalPath)).toBe(false);
        const published = yield* publishVerified(staged, assetsDir);
        expect(published).toEqual({ path: finalPath, digest, byteSize: pdf.length });
        expect(new Uint8Array(yield* fs.readFile(finalPath))).toEqual(pdf);
        expect(yield* fs.exists(staged.partPath)).toBe(true);
        expect(yield* publishVerified(staged, assetsDir)).toEqual(published);
        yield* staged.release;
        expect(yield* fs.exists(staged.partPath)).toBe(false);
        expect(new Uint8Array(yield* fs.readFile(finalPath))).toEqual(pdf);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("converges concurrent publications on one complete digest file", () =>
    Effect.gen(function* () {
      const { fs, stagingDir, assetsDir } = yield* fixture();
      const staged = yield* Effect.all(
        Array.from({ length: 4 }, () => stageUpload(reservation(stagingDir), Stream.make(pdf))),
        { concurrency: "unbounded" },
      );
      const results = yield* Effect.forEach(staged, (file) => publishVerified(file, assetsDir), {
        concurrency: "unbounded",
      });
      for (const result of results) {
        expect(result).toEqual(results[0]);
        expect(new Uint8Array(yield* fs.readFile(result.path))).toEqual(pdf);
      }
      expect(yield* fs.readDirectory(assetsDir)).toHaveLength(1);
      for (const file of staged) {
        expect(yield* fs.exists(file.partPath)).toBe(true);
        yield* file.release;
      }
      expect(new Uint8Array(yield* fs.readFile(results[0]!.path))).toEqual(pdf);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses corrupted, symlink and directory destinations without replacing them", () =>
    Effect.gen(function* () {
      const { fs, path, stagingDir, assetsDir } = yield* fixture();
      const content = new Uint8Array(192 * 1024);
      content.set(pdf);
      const staged = yield* stageUpload(
        reservation(stagingDir, content.length),
        Stream.make(content.subarray(0, 65536), content.subarray(65536)),
      );

      yield* fs.makeDirectory(assetsDir);
      const destination = path.join(assetsDir, staged.digest);
      yield* fs.writeFile(destination, content);
      expect((yield* publishVerified(staged, assetsDir)).byteSize).toBe(content.length);
      const corrupt = content.slice();
      corrupt[corrupt.length - 1] = 42;
      yield* fs.writeFile(destination, corrupt);
      expect(yield* publishVerified(staged, assetsDir).pipe(Effect.flip)).toMatchObject({
        reason: "destination_conflict",
      });
      expect(new Uint8Array(yield* fs.readFile(destination))).toEqual(corrupt);
      yield* fs.remove(destination);
      yield* fs.symlink(staged.partPath, destination);
      expect(yield* publishVerified(staged, assetsDir).pipe(Effect.flip)).toMatchObject({
        reason: "destination_conflict",
      });
      expect(yield* fs.readLink(destination)).toBe(staged.partPath);
      yield* fs.remove(destination);
      yield* fs.makeDirectory(destination);
      expect(yield* publishVerified(staged, assetsDir).pipe(Effect.flip)).toMatchObject({
        reason: "destination_conflict",
      });
      expect((yield* fs.stat(destination)).type).toBe("Directory");
      expect(new Uint8Array(yield* fs.readFile(staged.partPath))).toEqual(content);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects unsafe identifiers, digests and changed staging before publication", () =>
    Effect.gen(function* () {
      const { fs, stagingDir, assetsDir } = yield* fixture();
      for (const uploadId of ["../escape", "UPPERCASE", "a/b", "a\\b", "", "0".repeat(1000)]) {
        expect(
          yield* stageUpload({ ...reservation(stagingDir), uploadId }, Stream.make(pdf)).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ reason: "invalid_reservation" });
      }
      expect(yield* fs.exists(stagingDir)).toBe(false);
      const staged = yield* stageUpload(reservation(stagingDir), Stream.make(pdf));
      for (const digest of ["../escape", staged.digest.toUpperCase(), "f".repeat(63)]) {
        expect(
          yield* publishVerified({ ...staged, digest }, assetsDir).pipe(Effect.flip),
        ).toMatchObject({ reason: "invalid_reservation" });
      }
      yield* fs.rename(staged.partPath, `${staged.partPath}.old`);
      yield* fs.writeFile(staged.partPath, pdf);
      expect(yield* publishVerified(staged, assetsDir).pipe(Effect.flip)).toMatchObject({
        reason: "staging_changed",
      });
      expect(yield* fs.exists(assetsDir)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("releases a successful stage when its owning scope closes", () =>
    Effect.gen(function* () {
      const { fs, stagingDir } = yield* fixture();
      const partPath = yield* Effect.scoped(
        stageUpload(reservation(stagingDir), Stream.make(pdf)).pipe(
          Effect.map((staged) => staged.partPath),
        ),
      );
      expect(yield* fs.exists(partPath)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
