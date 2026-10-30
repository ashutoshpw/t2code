import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";

import * as SpacesSql from "../SpacesSql.ts";
import * as Sqlite from "../Sqlite.ts";
import * as Catalog from "./Catalog.ts";
import * as Upload from "./Upload.ts";
import * as GC from "./GC.ts";

const claimUpload = Effect.fn("AssetCatalogTest.claim")(function* (
  callerId: string,
  uploadId: string,
  now: number,
) {
  const owner = "20000000-0000-4000-8000-000000000000";
  yield* GC.initializeOwner(owner);
  return yield* Catalog.claim(callerId, uploadId, now, owner);
});
const bytes = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");
const input = (requestId: string, callerId = "client-a") => ({
  callerId,
  requestId,
  expectedBytes: bytes.length,
  mediaKind: "pdf" as const,
  mimeType: "application/pdf" as const,
  name: "report.pdf",
});
const paths = Effect.fn("AssetCatalogTest.paths")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t2-spaces-asset-catalog-" });
  return {
    fs,
    path,
    dbPath: path.join(root, "spaces.sqlite"),
    stagingDir: path.join(root, "staging"),
    assetsDir: path.join(root, "assets"),
  };
});
const scenario = Effect.fn("AssetCatalogTest.scenario")(function* <A, E, R>(
  use: (directories: Effect.Success<ReturnType<typeof paths>>) => Effect.Effect<A, E, R>,
) {
  const directories = yield* paths();
  return yield* use(directories).pipe(Effect.provide(Sqlite.layerFromPath(directories.dbPath)));
});
const upload = Effect.fn("AssetCatalogTest.upload")(function* (
  directories: Effect.Success<ReturnType<typeof paths>>,
  reservation: Parameters<typeof Catalog.reserve>[0],
  body: Stream.Stream<Uint8Array> = Stream.make(bytes),
) {
  const sql = yield* SpacesSql.SpacesSql;
  const reserved = yield* sql.withTransaction(Catalog.reserve(reservation, 0));
  const claim = yield* sql.withTransaction(claimUpload(reserved.caller_id, reserved.upload_id, 0));
  const staged = yield* Upload.stage(claim, directories.stagingDir, body);
  const verified = yield* sql.withTransaction(Catalog.recordVerified(claim, staged, 0));
  const proof = yield* Upload.publish(verified, staged, directories.assetsDir);
  const result = yield* sql.withTransaction(Catalog.finish(verified, proof, 0));
  yield* staged.release;
  const ready = yield* Catalog.getUpload(claim.caller_id, claim.upload_id);
  yield* sql.withTransaction(
    Catalog.releaseStaging(
      { ...ready, attempt_id: claim.attempt_id },
      yield* Upload.confirmNoStaging(
        { ...ready, attempt_id: claim.attempt_id },
        directories.stagingDir,
      ),
    ),
  );
  return { reserved, claim, verified, proof, result };
});
const snapshot = Effect.fn("AssetCatalogTest.snapshot")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  return {
    usage: yield* Catalog.usage(),
    ids: yield* sql`SELECT * FROM spaces_ids ORDER BY id`,
    uploads: yield* sql`SELECT * FROM spaces_asset_uploads ORDER BY upload_id`,
    callers: yield* sql`SELECT * FROM spaces_asset_callers ORDER BY caller_id`,
    blobs: yield* sql`SELECT * FROM spaces_asset_blobs ORDER BY digest`,
    assets: yield* sql`SELECT * FROM spaces_assets ORDER BY asset_id`,
  };
});

// These tests own real transaction accounting and persisted upload states, not HTTP authorization or framing.
describe("Spaces asset catalog", () => {
  it.effect(
    "runs the exact registered assets DDL on Spaces SQLite without changing its ledger or reference tables",
    () =>
      scenario(() =>
        Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          expect(
            yield* sql`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`,
          ).toEqual([
            { migration_id: 1, name: "Spaces" },
            { migration_id: 2, name: "Core" },
            { migration_id: 3, name: "RevisionPreimages" },
            { migration_id: 4, name: "PageOwners" },
            { migration_id: 5, name: "ReferenceIdentity" },
            { migration_id: 6, name: "Recovery" },
            { migration_id: 7, name: "Search" },
            { migration_id: 8, name: "Assets" },
            { migration_id: 9, name: "AssetReconciliation" },
            { migration_id: 10, name: "AssetCollection" },
            { migration_id: 11, name: "PageActivity" },
            { migration_id: 12, name: "PageLibrary" },
            { migration_id: 13, name: "LibraryRevisions" },
            { migration_id: 14, name: "PageShares" },
            { migration_id: 15, name: "PageIcon" },
          ]);
          expect(yield* sql`SELECT 1 FROM spaces WHERE is_default = 1`).toHaveLength(1);
          expect(yield* Catalog.usage()).toEqual({
            reserved_bytes: 0,
            physical_bytes: 0,
            pending_count: 0,
            active_count: 0,
          });
          expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
          expect(yield* sql`SELECT block_id,asset_id FROM spaces_block_asset_refs`).toEqual([]);
          expect(
            yield* sql`SELECT page_id,to_revision,asset_id FROM spaces_revision_asset_refs`,
          ).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "admits each file cap exactly and rolls back over-cap, mismatched intent and overlong metadata",
    () =>
      scenario(() =>
        Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          for (const [kind, mime, size] of [
            ["image", "image/png", 10 * 1024 ** 2],
            ["pdf", "application/pdf", 25 * 1024 ** 2],
            ["video", "video/mp4", 50 * 1024 ** 2],
          ] as const) {
            const request = {
              ...input(kind, kind),
              mediaKind: kind,
              mimeType: mime,
              expectedBytes: size,
            };
            const saved = yield* sql.withTransaction(Catalog.reserve(request, 0));
            expect(saved.expected_bytes).toBe(size);
            const before = yield* snapshot();
            for (const invalid of [
              { ...request, requestId: `${kind}-over`, expectedBytes: size + 1 },
              { ...request, name: "different" },
              { ...request, requestId: "long", name: "あ".repeat(86) },
            ]) {
              expect(
                (yield* sql.withTransaction(Catalog.reserve(invalid, 0)).pipe(Effect.flip))._tag,
              ).toBe("AssetCatalogError");
              expect(yield* snapshot()).toEqual(before);
            }
            expect(yield* sql.withTransaction(Catalog.reserve(request, 600_001))).toEqual(saved);
          }
          expect((yield* Catalog.usage()).reserved_bytes).toBe(85 * 1024 ** 2);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "serializes identical mint, caller pending limits, and independent caller identities",
    () =>
      scenario(() =>
        Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          const identical = yield* Effect.forEach(
            [0, 1],
            () => sql.withTransaction(Catalog.reserve(input("same"), 0)),
            { concurrency: "unbounded" },
          );
          expect(identical[0]).toEqual(identical[1]);
          yield* sql.withTransaction(Catalog.reserve(input("second"), 0));
          const before = yield* snapshot();
          expect(
            yield* sql.withTransaction(Catalog.reserve(input("third"), 0)).pipe(Effect.flip),
          ).toMatchObject({ reason: "pending_limit" });
          expect(yield* snapshot()).toEqual(before);
          const other = yield* sql.withTransaction(Catalog.reserve(input("same", "client-b"), 0));
          expect(other.upload_id).not.toBe(identical[0]!.upload_id);
          expect(
            yield* Catalog.getUpload("client-a", other.upload_id).pipe(Effect.flip),
          ).toMatchObject({ reason: "caller_mismatch" });
          expect(yield* Catalog.usage()).toEqual({
            reserved_bytes: 3 * bytes.length,
            physical_bytes: 0,
            pending_count: 3,
            active_count: 0,
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "bounds pending to16 and active claims to4 while refusing colliding claims atomically",
    () =>
      scenario(() =>
        Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          const reservations = [];
          for (let index = 0; index < 16; index++)
            reservations.push(
              yield* sql.withTransaction(
                Catalog.reserve(input(`${index}`, `caller-${Math.floor(index / 2)}`), 0),
              ),
            );
          const full = yield* snapshot();
          expect(
            yield* sql
              .withTransaction(Catalog.reserve(input("extra", "extra"), 0))
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "pending_limit" });
          expect(yield* snapshot()).toEqual(full);
          const first = reservations[0]!;
          const collision = yield* Effect.forEach(
            [0, 1],
            () =>
              sql
                .withTransaction(claimUpload(first.caller_id, first.upload_id, 0))
                .pipe(Effect.result),
            { concurrency: "unbounded" },
          );
          expect(collision.filter(Result.isSuccess)).toHaveLength(1);
          expect(collision.filter(Result.isFailure)).toMatchObject([
            { failure: { reason: "already_claimed" } },
          ]);
          for (const row of reservations.slice(2, 5))
            yield* sql.withTransaction(claimUpload(row.caller_id, row.upload_id, 0));
          const active = yield* snapshot();
          const refused = reservations[5]!;
          expect(
            yield* sql
              .withTransaction(claimUpload(refused.caller_id, refused.upload_id, 0))
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "active_limit" });
          expect(yield* snapshot()).toEqual(active);
          expect((yield* Catalog.usage()).active_count).toBe(4);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "streams outside SQL transactions, persists verification before publication, and returns one stable final result",
    () =>
      scenario((directories) =>
        Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          const row = yield* sql.withTransaction(Catalog.reserve(input("ordered"), 0));
          const claim = yield* sql.withTransaction(claimUpload(row.caller_id, row.upload_id, 0));
          const requested = yield* Deferred.make<void>();
          const remainder = yield* Deferred.make<Uint8Array>();
          const body = Stream.make(bytes.subarray(0, 8)).pipe(
            Stream.concat(
              Stream.fromEffect(
                Deferred.succeed(requested, undefined).pipe(
                  Effect.andThen(Deferred.await(remainder)),
                ),
              ),
            ),
          );
          const receiver = yield* Upload.stage(claim, directories.stagingDir, body).pipe(
            Effect.forkScoped,
          );
          yield* Deferred.await(requested);
          const unrelated = yield* sql.withTransaction(
            Catalog.reserve(input("other", "other-client"), 0),
          );
          expect(unrelated.state).toBe("reserved");
          expect(yield* Catalog.readyAsset(row.asset_id).pipe(Effect.flip)).toMatchObject({
            reason: "not_found",
          });
          yield* Deferred.succeed(remainder, bytes.subarray(8));
          const staged = yield* Fiber.join(receiver);
          const verified = yield* sql.withTransaction(Catalog.recordVerified(claim, staged, 0));
          const before = yield* snapshot();
          expect(
            yield* Upload.recoverPublication(verified, directories).pipe(Effect.result),
          ).toMatchObject({ _tag: "Success" });
          // Recovery may publish verified bytes, but only the final SQL transition makes an asset ready.
          expect(yield* Catalog.readyAsset(row.asset_id).pipe(Effect.flip)).toMatchObject({
            reason: "not_found",
          });
          expect(yield* snapshot()).toEqual(before);
          const proof = yield* Upload.publish(verified, staged, directories.assetsDir);
          expect(
            yield* sql.withTransaction(Catalog.recordVerified(claim, staged, 600_001)),
          ).toEqual(verified);
          const result = yield* sql.withTransaction(Catalog.finish(verified, proof, 600_001));
          expect(yield* sql.withTransaction(Catalog.finish(verified, proof, 600_002))).toEqual(
            result,
          );
          expect(yield* Catalog.readyAsset(result.assetId)).toMatchObject({
            digest: staged.digest,
            byte_size: bytes.length,
          });
          yield* staged.release;
          expect(yield* Catalog.usage()).toEqual({
            reserved_bytes: bytes.length,
            physical_bytes: bytes.length,
            pending_count: 2,
            active_count: 0,
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps failed streams retryable, rejects stale attempts and releases reservations on bounded idle expiry",
    () =>
      scenario((directories) =>
        Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          const reserved = yield* sql.withTransaction(Catalog.reserve(input("retry"), 0));
          const first = yield* sql.withTransaction(
            claimUpload(reserved.caller_id, reserved.upload_id, 0),
          );
          expect(
            yield* Upload.stage(
              first,
              directories.stagingDir,
              Stream.make(bytes.subarray(0, 8)).pipe(Stream.concat(Stream.fail("connection lost"))),
            ).pipe(Effect.flip),
          ).toMatchObject({ reason: "source_failed" });
          const absent = yield* Upload.confirmNoStaging(first, directories.stagingDir);
          yield* sql.withTransaction(Catalog.abort(first, absent, 1));
          expect(yield* Catalog.usage()).toEqual({
            reserved_bytes: bytes.length,
            physical_bytes: 0,
            pending_count: 1,
            active_count: 0,
          });
          const second = yield* sql.withTransaction(
            claimUpload(reserved.caller_id, reserved.upload_id, 2),
          );
          expect(second.attempt_id).not.toBe(first.attempt_id);
          const before = yield* snapshot();
          expect(
            yield* sql.withTransaction(Catalog.abort(first, absent, 2)).pipe(Effect.flip),
          ).toMatchObject({ reason: "stale_attempt" });
          expect(yield* snapshot()).toEqual(before);
          const staged = yield* Upload.stage(second, directories.stagingDir, Stream.make(bytes));
          expect(
            yield* Upload.confirmNoStaging(second, directories.stagingDir).pipe(Effect.flip),
          ).toMatchObject({ reason: "staging_present" });
          yield* staged.release;
          yield* sql.withTransaction(
            Catalog.abort(
              second,
              yield* Upload.confirmNoStaging(second, directories.stagingDir),
              3,
            ),
          );
          expect(yield* sql.withTransaction(Catalog.expireIdle(600_000))).toBe(1);
          expect(yield* Catalog.usage()).toEqual({
            reserved_bytes: 0,
            physical_bytes: 0,
            pending_count: 0,
            active_count: 0,
          });
          expect(
            yield* sql
              .withTransaction(claimUpload(reserved.caller_id, reserved.upload_id, 600_000))
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "expired" });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "deduplicates physical bytes across distinct revocable handles without changing finalize replay",
    () =>
      scenario((directories) =>
        Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          const first = yield* upload(directories, input("first"));
          const second = yield* upload(directories, { ...input("second"), name: "copy.pdf" });
          expect(second.result.digest).toBe(first.result.digest);
          expect(second.result.assetId).not.toBe(first.result.assetId);
          const beforeMismatch = yield* snapshot();
          expect(
            yield* sql
              .withTransaction(Catalog.finish(first.verified, second.proof, 1))
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "intent_mismatch" });
          expect(yield* snapshot()).toEqual(beforeMismatch);
          expect(yield* Catalog.usage()).toEqual({
            reserved_bytes: 0,
            physical_bytes: bytes.length,
            pending_count: 0,
            active_count: 0,
          });
          expect(yield* directories.fs.readDirectory(directories.assetsDir)).toHaveLength(1);
          yield* sql.withTransaction(Catalog.revoke(first.result.assetId, 5));
          expect(yield* Catalog.readyAsset(first.result.assetId).pipe(Effect.flip)).toMatchObject({
            reason: "not_found",
          });
          expect((yield* Catalog.readyAsset(second.result.assetId)).name).toBe("copy.pdf");
          expect(
            yield* sql.withTransaction(Catalog.finish(first.verified, first.proof, 6)),
          ).toEqual(first.result);
          expect(yield* Catalog.readyAsset(first.result.assetId).pipe(Effect.flip)).toMatchObject({
            reason: "not_found",
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retains separate dedup staging bytes until physical cleanup is acknowledged", () =>
    scenario((directories) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        yield* upload(directories, input("original"));
        const row = yield* sql.withTransaction(Catalog.reserve(input("separate"), 0));
        const claim = yield* sql.withTransaction(claimUpload(row.caller_id, row.upload_id, 0));
        const staged = yield* Upload.stage(claim, directories.stagingDir, Stream.make(bytes));
        const verified = yield* sql.withTransaction(Catalog.recordVerified(claim, staged, 0));
        const proof = yield* Upload.publish(verified, staged, directories.assetsDir);
        yield* sql.withTransaction(Catalog.finish(verified, proof, 0));
        expect(yield* directories.fs.exists(staged.partPath)).toBe(true);
        expect(yield* Catalog.usage()).toEqual({
          reserved_bytes: bytes.length,
          physical_bytes: bytes.length,
          pending_count: 1,
          active_count: 0,
        });
        const ready = {
          ...(yield* Catalog.getUpload(row.caller_id, row.upload_id)),
          attempt_id: claim.attempt_id,
        };
        expect(
          yield* Upload.confirmNoStaging(ready, directories.stagingDir).pipe(Effect.flip),
        ).toMatchObject({ reason: "staging_present" });
        yield* staged.release;
        const absent = yield* Upload.confirmNoStaging(ready, directories.stagingDir);
        yield* sql.withTransaction(Catalog.releaseStaging(ready, absent));
        yield* sql.withTransaction(Catalog.releaseStaging(ready, absent));
        expect(yield* Catalog.usage()).toEqual({
          reserved_bytes: 0,
          physical_bytes: bytes.length,
          pending_count: 0,
          active_count: 0,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps concurrent same-digest finalizations and cleanup acknowledgements exactly accounted",
    () =>
      scenario((directories) =>
        Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          const staged = yield* Effect.forEach(
            ["a", "b"],
            (caller) =>
              Effect.gen(function* () {
                const row = yield* sql.withTransaction(
                  Catalog.reserve(input("concurrent", caller), 0),
                );
                const claim = yield* sql.withTransaction(
                  claimUpload(row.caller_id, row.upload_id, 0),
                );
                const file = yield* Upload.stage(claim, directories.stagingDir, Stream.make(bytes));
                const verified = yield* sql.withTransaction(Catalog.recordVerified(claim, file, 0));
                return { file, verified };
              }),
            { concurrency: "unbounded" },
          );
          const finished = yield* Effect.forEach(
            staged,
            ({ file, verified }) =>
              Effect.gen(function* () {
                const proof = yield* Upload.publish(verified, file, directories.assetsDir);
                return yield* sql.withTransaction(Catalog.finish(verified, proof, 0));
              }),
            { concurrency: "unbounded" },
          );
          expect(new Set(finished.map((row) => row.assetId)).size).toBe(2);
          expect(yield* Catalog.usage()).toEqual({
            reserved_bytes: bytes.length,
            physical_bytes: bytes.length,
            pending_count: 2,
            active_count: 0,
          });
          for (const { file, verified } of staged) {
            yield* file.release;
            const ready = {
              ...(yield* Catalog.getUpload(verified.caller_id, verified.upload_id)),
              attempt_id: verified.attempt_id,
            };
            const absent = yield* Upload.confirmNoStaging(ready, directories.stagingDir);
            yield* sql.withTransaction(Catalog.releaseStaging(ready, absent));
          }
          expect(yield* Catalog.usage()).toEqual({
            reserved_bytes: 0,
            physical_bytes: bytes.length,
            pending_count: 0,
            active_count: 0,
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "recovers abandoned partial receiving attempts only after staging cleanup and bounds recovery IO planning",
    () =>
      scenario((directories) =>
        Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          const row = yield* sql.withTransaction(Catalog.reserve(input("abandoned"), 0));
          const claim = yield* sql.withTransaction(claimUpload(row.caller_id, row.upload_id, 0));
          yield* directories.fs.makeDirectory(directories.stagingDir, { recursive: true });
          const part = directories.path.join(directories.stagingDir, `${claim.attempt_id}.part`);
          yield* directories.fs.writeFile(part, bytes.subarray(0, 8));
          expect(
            yield* Upload.confirmNoStaging(claim, directories.stagingDir).pipe(Effect.flip),
          ).toMatchObject({ reason: "staging_present" });
          expect(yield* sql.withTransaction(Catalog.expireIdle(600_000))).toBe(0);
          const absent = yield* Upload.discardAbandonedStaging(claim, directories);
          yield* sql.withTransaction(Catalog.abort(claim, absent, 600_000));
          expect(yield* Catalog.usage()).toEqual({
            reserved_bytes: 0,
            physical_bytes: 0,
            pending_count: 0,
            active_count: 0,
          });
          for (let index = 0; index < 4; index++) {
            const pending = yield* sql.withTransaction(
              Catalog.reserve(
                {
                  ...input(`${index}`, `large-${index}`),
                  expectedBytes: 50 * 1024 ** 2,
                  mediaKind: "video",
                  mimeType: "video/mp4",
                },
                600_000,
              ),
            );
            yield* sql.withTransaction(claimUpload(pending.caller_id, pending.upload_id, 600_000));
          }
          const first = yield* Catalog.recoveryBatch();
          expect(first).toHaveLength(2);
          const second = yield* Catalog.recoveryBatch(first.at(-1)!.upload_id);
          expect(second).toHaveLength(2);
          expect(new Set([...first, ...second].map((item) => item.upload_id)).size).toBe(4);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back allocated identities and all counters with the caller transaction", () =>
    scenario(() =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        const before = yield* snapshot();
        expect(
          yield* sql
            .withTransaction(
              Catalog.reserve(input("rollback"), 0).pipe(
                Effect.andThen(Effect.fail("later caller failure")),
              ),
            )
            .pipe(Effect.flip),
        ).toBe("later caller failure");
        expect(yield* snapshot()).toEqual(before);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("persists sniffed image dimensions with the ready handle", () =>
    scenario((directories) =>
      Effect.gen(function* () {
        const image = new Uint8Array(
          Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
        );
        const result = yield* upload(
          directories,
          {
            ...input("image"),
            expectedBytes: image.length,
            mediaKind: "image",
            mimeType: "image/gif",
            name: "image.gif",
          },
          Stream.make(image),
        );
        expect(yield* Catalog.readyAsset(result.result.assetId)).toMatchObject({
          mime_type: "image/gif",
          width: 1,
          height: 1,
          byte_size: image.length,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["verified-part", "published", "ready", "ready-dedup"] as const)(
    "recovers persisted %s state after closing and reopening SQLite",
    (phase) =>
      Effect.gen(function* () {
        const directories = yield* paths();
        const heldScope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(heldScope, exit));
        const original = yield* Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          if (phase === "ready-dedup") yield* upload(directories, input("earlier"));
          const row = yield* sql.withTransaction(Catalog.reserve(input("reopen"), 0));
          const claim = yield* sql.withTransaction(claimUpload(row.caller_id, row.upload_id, 0));
          const staged = yield* Upload.stage(
            claim,
            directories.stagingDir,
            Stream.make(bytes),
          ).pipe(Effect.provideService(Scope.Scope, heldScope));
          const verified = yield* sql.withTransaction(Catalog.recordVerified(claim, staged, 0));
          if (phase !== "verified-part") {
            const proof = yield* Upload.publish(verified, staged, directories.assetsDir);
            if (phase === "ready" || phase === "ready-dedup")
              yield* sql.withTransaction(Catalog.finish(verified, proof, 1));
            if (phase !== "ready-dedup") yield* staged.release;
          }
          return { uploadId: row.upload_id, assetId: row.asset_id };
        }).pipe(Effect.provide(Sqlite.layerFromPath(directories.dbPath)), Effect.scoped);
        yield* Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          const row = yield* Catalog.getUpload("client-a", original.uploadId);
          expect(row.attempt_id).not.toBeNull();
          if (row.attempt_id === null) throw new Error("Missing persisted claim");
          const claim = { ...row, attempt_id: row.attempt_id };
          const proof = yield* Upload.recoverPublication(claim, directories);
          const result = yield* sql.withTransaction(Catalog.finish(claim, proof, 900_000));
          expect(result.assetId).toBe(original.assetId);
          if (phase === "ready-dedup") {
            expect((yield* Catalog.usage()).reserved_bytes).toBe(bytes.length);
            expect((yield* Catalog.recoveryBatch()).map((item) => item.upload_id)).toContain(
              claim.upload_id,
            );
          }
          const ready = {
            ...(yield* Catalog.getUpload(claim.caller_id, claim.upload_id)),
            attempt_id: claim.attempt_id,
          };
          const absent = yield* Upload.discardAbandonedStaging(ready, directories, proof);
          yield* sql.withTransaction(Catalog.releaseStaging(ready, absent));
          expect(yield* sql.withTransaction(Catalog.finish(claim, proof, 900_001))).toEqual(result);
          expect(yield* Catalog.usage()).toEqual({
            reserved_bytes: 0,
            physical_bytes: bytes.length,
            pending_count: 0,
            active_count: 0,
          });
          expect((yield* Catalog.readyAsset(result.assetId)).digest).toBe(result.digest);
        }).pipe(Effect.provide(Sqlite.layerFromPath(directories.dbPath)), Effect.scoped);
        yield* Scope.close(heldScope, Exit.void);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("safely retries verified state whose unpublished staging disappeared", () =>
    scenario((directories) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        const row = yield* sql.withTransaction(Catalog.reserve(input("missing"), 0));
        const claim = yield* sql.withTransaction(claimUpload(row.caller_id, row.upload_id, 0));
        const staged = yield* Upload.stage(claim, directories.stagingDir, Stream.make(bytes));
        const verified = yield* sql.withTransaction(Catalog.recordVerified(claim, staged, 0));
        yield* staged.release;
        expect(
          yield* Upload.recoverPublication(verified, directories).pipe(Effect.flip),
        ).toMatchObject({ reason: "missing_file" });
        const missing = yield* Upload.confirmMissingPublication(verified, directories);
        yield* sql.withTransaction(Catalog.resetMissing(verified, missing, 1));
        expect(yield* Catalog.usage()).toEqual({
          reserved_bytes: bytes.length,
          physical_bytes: 0,
          pending_count: 1,
          active_count: 0,
        });
        const result = yield* upload(directories, input("missing"));
        expect(result.result.assetId).toBe(row.asset_id);
        expect(result.claim.attempt_id).not.toBe(claim.attempt_id);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects corrupt recovery and deletion generations without ready rows or resurrection",
    () =>
      scenario((directories) =>
        Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          const row = yield* sql.withTransaction(Catalog.reserve(input("generation"), 0));
          const claim = yield* sql.withTransaction(claimUpload(row.caller_id, row.upload_id, 0));
          const staged = yield* Upload.stage(claim, directories.stagingDir, Stream.make(bytes));
          const verified = yield* sql.withTransaction(Catalog.recordVerified(claim, staged, 0));
          const proof = yield* Upload.publish(verified, staged, directories.assetsDir);
          yield* staged.release;
          const destination = Upload.publicationInfo(proof).path;
          const corrupt = bytes.slice();
          corrupt[corrupt.length - 1] = 42;
          yield* directories.fs.writeFile(destination, corrupt);
          expect(
            yield* Upload.recoverPublication(verified, directories).pipe(Effect.flip),
          ).toMatchObject({ reason: "corrupt_file" });
          expect(yield* Catalog.readyAsset(row.asset_id).pipe(Effect.flip)).toMatchObject({
            reason: "not_found",
          });
          // This is a future GC barrier on a genuinely uploaded blob, not fabricated ready storage.
          yield* sql`UPDATE spaces_asset_blobs SET state = 'deleting',generation = generation + 1 WHERE digest = ${verified.digest}`;
          const before = yield* snapshot();
          expect(
            yield* sql.withTransaction(Catalog.finish(verified, proof, 1)).pipe(Effect.flip),
          ).toMatchObject({ reason: "blob_unavailable" });
          expect(yield* snapshot()).toEqual(before);
          const other = yield* sql.withTransaction(
            Catalog.reserve(input("other", "other-client"), 0),
          );
          const next = yield* sql.withTransaction(claimUpload(other.caller_id, other.upload_id, 0));
          const nextStage = yield* Upload.stage(next, directories.stagingDir, Stream.make(bytes));
          expect(
            yield* sql
              .withTransaction(Catalog.recordVerified(next, nextStage, 0))
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "blob_unavailable" });
          yield* nextStage.release;
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "enforces the2GiB unique physical plus reserved boundary using real distinct files",
    () =>
      scenario((directories) =>
        Effect.gen(function* () {
          const sql = yield* SpacesSql.SpacesSql;
          const maximum = 2 * 1024 ** 3;
          const header = new Uint8Array([
            0,
            0,
            0,
            24,
            ...new TextEncoder().encode("ftypisom"),
            0,
            0,
            0,
            0,
            ...new TextEncoder().encode("isommp42"),
          ]);
          for (let index = 0; index < 41; index++) {
            const size = index === 40 ? 48 * 1024 ** 2 : 50 * 1024 ** 2;
            const fill = new Uint8Array(64 * 1024).fill(index + 1);
            const body = Stream.make(header).pipe(
              Stream.concat(
                Stream.fromIterable(
                  (function* () {
                    for (
                      let remaining = size - header.length;
                      remaining > 0;
                      remaining -= fill.length
                    )
                      yield fill.subarray(0, Math.min(remaining, fill.length));
                  })(),
                ),
              ),
            );
            yield* upload(
              directories,
              {
                ...input(`quota-${index}`),
                expectedBytes: size,
                mediaKind: "video",
                mimeType: "video/mp4",
                name: "clip.mp4",
              },
              body,
            );
          }
          expect(yield* Catalog.usage()).toEqual({
            reserved_bytes: 0,
            physical_bytes: maximum,
            pending_count: 0,
            active_count: 0,
          });
          const before = yield* snapshot();
          expect(
            yield* sql
              .withTransaction(Catalog.reserve({ ...input("over"), expectedBytes: 1 }, 0))
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "quota" });
          expect(yield* snapshot()).toEqual(before);
          expect(yield* directories.fs.readDirectory(directories.assetsDir)).toHaveLength(41);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
