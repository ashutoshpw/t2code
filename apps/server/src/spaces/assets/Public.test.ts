import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t2code/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter } from "effect/http";

import * as Config from "../../config.ts";
import * as Settings from "../../serverSettings.ts";
import * as Identity from "../../environment/ServerEnvironment.ts";
import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as ServerHttp from "../../http.ts";
import * as BuiltInDrivers from "../../sourceControl/builtInDrivers.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as Favicon from "../../project/ProjectFaviconResolver.ts";
import * as ProjectLoader from "../../project/T2ProjectFileLoader.ts";
import * as NativeIcons from "../../assets/NativeAppIconResolver.ts";
import { issueAssetUrl } from "../../assets/AssetAccess.ts";
import * as Service from "../SpacesService.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as Sqlite from "../Sqlite.ts";
import * as Catalog from "./Catalog.ts";
import * as Upload from "./Upload.ts";

const environmentId = EnvironmentId.make("public-assets");
const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");
const video = new Uint8Array([
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
  0,
  0,
  0,
  8,
  ...new TextEncoder().encode("mdat"),
]);
const common = (requestId: string, data = pdf) => ({
  environmentId,
  requestId,
  expectedBytes: data.length,
  mediaKind: "pdf" as const,
  mimeType: "application/pdf" as const,
  name: "report.pdf",
});
const fixture = Effect.fn("SpacesAssetsPublicTest.fixture")(function* <A, E, R>(
  use: (input: {
    readonly config: Config.ServerConfig["Service"];
    readonly request: (relative: string, init?: RequestInit) => Effect.Effect<Response>;
  }) => Effect.Effect<A, E, R>,
  enabled = true,
) {
  const scope = yield* Effect.scope;
  const clock = yield* Clock.Clock;
  const configContext = yield* Layer.buildWithScope(
    Config.ServerConfig.layerTest(process.cwd(), { prefix: "spaces-public-" }),
    scope,
  );
  const config = Context.get(configContext, Config.ServerConfig);
  const configLayer = Layer.succeedContext(configContext);
  const settings = Settings.layerTest({ spacesEnabled: enabled });
  const spaces = Service.layerFromPath(config.spacesDbPath, {
    stagingDir: config.spacesStagingDir,
    assetsDir: config.spacesAssetsDir,
  }).pipe(
    Layer.provide(settings),
    Layer.provide(
      Layer.succeed(Identity.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
  );
  const context = yield* Layer.buildWithScope(
    Layer.mergeAll(
      configLayer,
      settings,
      spaces,
      Secrets.layer.pipe(Layer.provide(configLayer)),
      WorkspacePaths.layer,
      Favicon.layer.pipe(Layer.provide(WorkspacePaths.layer), Layer.provide(ProjectLoader.layer)),
      NativeIcons.layer.pipe(Layer.provide(configLayer)),
      NodeHttpPlatform.layer,
      // Legacy non-Spaces branches are outside this fixture; the actual Spaces service/files/SQL are used.
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.succeed(BuiltInDrivers.SourceControlDrivers, []),
      Layer.succeed(Clock.Clock, clock),
    ).pipe(Layer.provideMerge(NodeServices.layer)),
    scope,
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(
      ServerHttp.layerSpacesUploadRoute,
      ServerHttp.layerAssetRoute,
      ServerHttp.layerHttpCompression,
    ).pipe(Layer.provideMerge(Layer.succeedContext(context))),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const request = (relative: string, init?: RequestInit) =>
    Effect.promise(() => handler(new Request(`http://assets.test${relative}`, init)));
  return yield* use({ config, request }).pipe(Effect.provide(context));
}, Effect.provide(NodeServices.layer));
const usage = Effect.fn("SpacesAssetsPublicTest.usage")(function* (
  config: Config.ServerConfig["Service"],
) {
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql<{
      readonly reserved_bytes: number;
      readonly physical_bytes: number;
      readonly pending_count: number;
      readonly active_count: number;
    }>`SELECT reserved_bytes,physical_bytes,pending_count,active_count FROM spaces_asset_usage WHERE singleton = 1`)[0]!;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath, readonly: true })),
  );
});

describe("Spaces public asset wiring", () => {
  it.effect.each([".", "..", "normal.pdf", "dir/file.pdf", "%2e%2e", "odd\\file.pdf"])(
    "admits a routable name or refuses %s before binding the upload intent",
    (name) =>
      fixture(({ request, config }) =>
        Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          const input = { ...common("name"), name };
          if (name === "." || name === "..") {
            expect(
              yield* service.createAssetUpload(input, "owner").pipe(Effect.flip),
            ).toMatchObject({ reason: "invalid_input" });
            expect((yield* usage(config)).pending_count).toBe(0);
            input.name = "report.pdf";
          }
          const minted = yield* service.createAssetUpload(input, "owner");
          expect(yield* service.createAssetUpload(input, "owner")).toEqual(minted);
          expect(
            (yield* request(minted.relativeUrl, {
              method: "POST",
              headers: { "content-length": String(pdf.length) },
              body: new Uint8Array(pdf),
            })).status,
          ).toBe(204);
          const saved = yield* service.finalizeAssetUpload(
            { environmentId, uploadId: minted.uploadId },
            "owner",
          );
          expect(saved.name).toBe(input.name);
          expect(
            (yield* service.getAssetMetadata({ environmentId, assetId: saved.assetId })).name,
          ).toBe(input.name);
          const signed = yield* issueAssetUrl({
            resource: { _tag: "spaces-asset", environmentId, assetId: saved.assetId },
          });
          const url = new URL(signed.relativeUrl, "http://assets.test");
          expect(url.pathname.endsWith(`/${encodeURIComponent(input.name)}`)).toBe(true);
          const response = yield* request(signed.relativeUrl);
          expect(response.status).toBe(200);
          expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(pdf);
          const doubleEncoded = signed.relativeUrl.replace(
            /\/[^/]+$/,
            `/${encodeURIComponent(encodeURIComponent(input.name))}`,
          );
          if (doubleEncoded !== signed.relativeUrl)
            expect((yield* request(doubleEncoded)).status).toBe(404);
        }),
      ),
  );

  it.effect("reports abandoned work beyond large live uploads and retires live ownership", () =>
    fixture(({ config }) =>
      Effect.gen(function* () {
        const service = yield* Service.SpacesService;
        const fs = yield* FileSystem.FileSystem;
        const minted = yield* Effect.forEach(["one", "two", "three"], (caller) =>
          service
            .createAssetUpload(
              {
                ...common(caller),
                expectedBytes: 50 * 1024 ** 2,
                mediaKind: "video",
                mimeType: "video/mp4",
                name: "movie.mp4",
              },
              caller,
            )
            .pipe(Effect.map((upload) => ({ ...upload, caller }))),
        );
        minted.sort((a, b) => a.uploadId.localeCompare(b.uploadId));
        const receivers = yield* Effect.forEach(minted.slice(0, 2), (upload) =>
          Effect.gen(function* () {
            const requested = yield* Deferred.make<void>();
            const body = Stream.make(video).pipe(
              Stream.concat(
                Stream.fromEffect(
                  Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
                ),
              ),
            );
            const receiver = yield* service
              .receiveAssetUpload(
                upload.relativeUrl.slice(upload.relativeUrl.lastIndexOf("/") + 1),
                String(50 * 1024 ** 2),
                body,
              )
              .pipe(Effect.forkScoped);
            yield* Deferred.await(requested);
            return receiver;
          }),
        );
        expect((yield* service.getCapability(environmentId))?.assetRecoveryPending).toBe(false);
        yield* fs.writeFileString(config.spacesAssetsDir, "blocks atomic publication");
        const first = new Uint8Array(64 * 1024);
        first.set(video);
        const rest = new Uint8Array(64 * 1024);
        const abandoned = minted[2]!;
        expect(
          yield* service
            .receiveAssetUpload(
              abandoned.relativeUrl.slice(abandoned.relativeUrl.lastIndexOf("/") + 1),
              String(50 * 1024 ** 2),
              Stream.make(first).pipe(
                Stream.concat(Stream.fromIterable(Array.from({ length: 799 }, () => rest))),
              ),
            )
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "publication_failed" });
        expect(
          yield* service.getAssetUpload(
            { environmentId, uploadId: abandoned.uploadId },
            abandoned.caller,
          ),
        ).toMatchObject({ state: "verified", recoveryPending: true });
        expect((yield* service.getCapability(environmentId))?.assetRecoveryPending).toBe(true);
        yield* Effect.forEach(receivers, (receiver) => Fiber.interrupt(receiver));
        for (const upload of minted.slice(0, 2))
          expect(
            yield* service.getAssetUpload(
              { environmentId, uploadId: upload.uploadId },
              upload.caller,
            ),
          ).toMatchObject({ state: "reserved", recoveryPending: false });
        yield* fs.remove(config.spacesAssetsDir);
        expect(
          yield* service
            .finalizeAssetUpload({ environmentId, uploadId: abandoned.uploadId }, abandoned.caller)
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "not_ready" });
        expect((yield* service.getCapability(environmentId))?.assetRecoveryPending).toBe(false);
        expect((yield* usage(config)).active_count).toBe(0);
      }),
    ),
  );

  it.effect.each(["pdf", "video", "image"] as const)(
    "serves a bearer %s through upload/finalize and the existing signed route",
    (kind) =>
      fixture(({ request, config }) =>
        Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          const data =
            kind === "pdf"
              ? pdf
              : kind === "video"
                ? video
                : new Uint8Array(
                    Buffer.from(
                      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
                      "base64",
                    ),
                  );
          const input = {
            ...common(kind, data),
            mediaKind: kind === "image" ? ("image" as const) : kind,
            mimeType:
              kind === "image"
                ? ("image/gif" as const)
                : kind === "video"
                  ? ("video/mp4" as const)
                  : ("application/pdf" as const),
            name: kind === "image" ? "picture.gif" : kind === "video" ? "movie.mp4" : "report.pdf",
          };
          const minted = yield* service.createAssetUpload(input, "owner");
          expect(
            yield* service
              .getAssetMetadata({ environmentId, assetId: minted.assetId })
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "not_found" });
          const posted = yield* request(minted.relativeUrl, {
            method: "POST",
            headers: { "content-length": String(data.length) },
            body: new Uint8Array(data),
          });
          expect(posted.status).toBe(204);
          const saved = yield* service.finalizeAssetUpload(
            { environmentId, uploadId: minted.uploadId },
            "owner",
          );
          expect(
            yield* service.finalizeAssetUpload(
              { environmentId, uploadId: minted.uploadId },
              "owner",
            ),
          ).toEqual(saved);
          const signed = yield* issueAssetUrl({
            resource: { _tag: "spaces-asset", environmentId, assetId: saved.assetId },
          });
          const full = yield* request(signed.relativeUrl);
          expect(full.status).toBe(200);
          expect(new Uint8Array(yield* Effect.promise(() => full.arrayBuffer()))).toEqual(data);
          expect(full.headers.get("content-type")).toBe(input.mimeType);
          expect(full.headers.get("etag")).toBe(`"${saved.digest}"`);
          expect(full.headers.get("cache-control")).toBe("private, immutable, no-transform");
          const head = yield* request(signed.relativeUrl, { method: "HEAD" });
          expect(head.status).toBe(200);
          expect(head.headers.get("content-length")).toBe(String(data.length));
          expect(yield* Effect.promise(() => head.text())).toBe("");
          const range = yield* request(signed.relativeUrl, {
            headers: { range: "bytes=2-5", "if-range": `"${saved.digest}"` },
          });
          expect(range.status).toBe(206);
          expect(new Uint8Array(yield* Effect.promise(() => range.arrayBuffer()))).toEqual(
            data.subarray(2, 6),
          );
          expect(
            (yield* request(signed.relativeUrl.replace(/\/[^/]+$/, "/sibling.pdf"))).status,
          ).toBe(404);
          expect(
            (yield* request(signed.relativeUrl.replace("/api/assets/", "/api/assets/tampered")))
              .status,
          ).toBe(404);
          expect(
            yield* service
              .getAssetUpload({ environmentId, uploadId: minted.uploadId }, "another")
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "caller_mismatch" });
          expect(yield* usage(config)).toEqual({
            reserved_bytes: 0,
            physical_bytes: data.length,
            pending_count: 0,
            active_count: 0,
          });
        }),
      ),
  );

  it.effect(
    "rejects missing/malformed lengths before claim and short/excess streams without active-slot leaks",
    () =>
      fixture(({ request, config }) =>
        Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          const minted = yield* service.createAssetUpload(common("length"), "owner");
          for (const length of [
            undefined,
            "-1",
            `+${pdf.length}`,
            `0${pdf.length}`,
            `${pdf.length}.0`,
          ]) {
            const response = yield* request(minted.relativeUrl, {
              method: "POST",
              headers: length === undefined ? {} : { "content-length": length },
              body: new Uint8Array(pdf),
            });
            expect(response.status).toBe(400);
          }
          for (const data of [pdf.subarray(0, pdf.length - 1), new Uint8Array([...pdf, 42])]) {
            const response = yield* request(minted.relativeUrl, {
              method: "POST",
              headers: { "content-length": String(pdf.length) },
              body: new Uint8Array(data),
            });
            expect(response.status).toBe(400);
            expect(
              (yield* service.getAssetUpload({ environmentId, uploadId: minted.uploadId }, "owner"))
                .state,
            ).toBe("reserved");
            expect((yield* usage(config)).active_count).toBe(0);
          }
          expect(
            (yield* request(minted.relativeUrl, {
              method: "POST",
              headers: { "content-length": String(pdf.length) },
              body: new Uint8Array(pdf),
            })).status,
          ).toBe(204);
          expect(yield* usage(config)).toEqual({
            reserved_bytes: 0,
            physical_bytes: pdf.length,
            pending_count: 0,
            active_count: 0,
          });
        }),
      ),
  );

  it.effect(
    "keeps disabled startup lazy and revokes existing URLs on disable or catalog deletion",
    () =>
      fixture(
        ({ request, config }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const service = yield* Service.SpacesService;
            const settings = yield* Settings.ServerSettingsService;
            expect(yield* service.getCapability(environmentId)).toBeNull();
            expect(yield* fs.exists(config.spacesDbPath)).toBe(false);
            expect(
              (yield* request("/api/spaces/assets/upload/invalid", { method: "POST", body: "bad" }))
                .status,
            ).toBe(404);
            expect(yield* fs.exists(config.spacesDbPath)).toBe(false);
            yield* settings.updateSettings({ spacesEnabled: true });
            const minted = yield* service.createAssetUpload(common("toggle"), "owner");
            yield* request(minted.relativeUrl, {
              method: "POST",
              headers: { "content-length": String(pdf.length) },
              body: new Uint8Array(pdf),
            });
            const signed = yield* issueAssetUrl({
              resource: { _tag: "spaces-asset", environmentId, assetId: minted.assetId },
            });
            yield* settings.updateSettings({ spacesEnabled: false });
            expect((yield* request(signed.relativeUrl)).status).toBe(404);
            expect(
              yield* service
                .finalizeAssetUpload({ environmentId, uploadId: minted.uploadId }, "owner")
                .pipe(Effect.flip),
            ).toMatchObject({ _tag: "SpacesDisabledError" });
            yield* settings.updateSettings({ spacesEnabled: true });
            expect((yield* request(signed.relativeUrl)).status).toBe(200);
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE spaces_assets SET state = 'deleted' WHERE asset_id = ${minted.assetId}`;
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
            expect((yield* request(signed.relativeUrl)).status).toBe(404);
          }),
        false,
      ),
  );

  it.effect("expires upload grants and signed read URLs while finalize results remain stable", () =>
    fixture(({ request, config }) =>
      Effect.gen(function* () {
        const service = yield* Service.SpacesService;
        const ready = yield* service.createAssetUpload(common("ready"), "owner");
        yield* request(ready.relativeUrl, {
          method: "POST",
          headers: { "content-length": String(pdf.length) },
          body: new Uint8Array(pdf),
        });
        const signed = yield* issueAssetUrl({
          resource: { _tag: "spaces-asset", environmentId, assetId: ready.assetId },
        });
        const pending = yield* service.createAssetUpload(common("expired"), "owner");
        yield* TestClock.adjust("11 minutes");
        expect(
          (yield* request(pending.relativeUrl, {
            method: "POST",
            headers: { "content-length": String(pdf.length) },
            body: new Uint8Array(pdf),
          })).status,
        ).toBe(404);
        expect(
          (yield* service.getAssetUpload({ environmentId, uploadId: pending.uploadId }, "owner"))
            .state,
        ).toBe("expired");
        expect((yield* usage(config)).reserved_bytes).toBe(0);
        yield* TestClock.adjust("50 minutes");
        expect((yield* request(signed.relativeUrl)).status).toBe(404);
        expect(
          (yield* service.finalizeAssetUpload({ environmentId, uploadId: ready.uploadId }, "owner"))
            .assetId,
        ).toBe(ready.assetId);
      }),
    ),
  );

  it.effect(
    "never reclaims a live receiver and permits retry after actual fiber cancellation",
    () =>
      fixture(({ request, config }) =>
        Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          const minted = yield* service.createAssetUpload(common("cancel"), "owner");
          const requested = yield* Deferred.make<void>();
          const body = Stream.make(pdf.subarray(0, 8)).pipe(
            Stream.concat(
              Stream.fromEffect(
                Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never)),
              ),
            ),
          );
          const token = minted.relativeUrl.slice(minted.relativeUrl.lastIndexOf("/") + 1);
          const receiver = yield* service
            .receiveAssetUpload(token, String(pdf.length), body)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(requested);
          expect((yield* usage(config)).active_count).toBe(1);
          expect(
            yield* service
              .finalizeAssetUpload({ environmentId, uploadId: minted.uploadId }, "owner")
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "already_claimed" });
          expect((yield* service.getCapability(environmentId))?.assetRecoveryPending).toBe(false);
          yield* Fiber.interrupt(receiver);
          expect((yield* usage(config)).active_count).toBe(0);
          expect(
            (yield* service.getAssetUpload({ environmentId, uploadId: minted.uploadId }, "owner"))
              .state,
          ).toBe("reserved");
          expect(
            (yield* request(minted.relativeUrl, {
              method: "POST",
              headers: { "content-length": String(pdf.length) },
              body: new Uint8Array(pdf),
            })).status,
          ).toBe(204);
        }),
      ),
  );

  it.effect(
    "recovers a genuinely verified/published abandoned upload at first enabled acquisition",
    () =>
      fixture(({ config }) =>
        Effect.gen(function* () {
          const stored = yield* Effect.gen(function* () {
            const sql = yield* SpacesSql.SpacesSql;
            const row = yield* sql.withTransaction(
              Catalog.reserve(
                {
                  callerId: "owner",
                  requestId: "abandoned",
                  expectedBytes: pdf.length,
                  mimeType: "application/pdf",
                  mediaKind: "pdf",
                  name: "report.pdf",
                },
                0,
              ),
            );
            const claim = yield* sql.withTransaction(
              Catalog.claim(row.caller_id, row.upload_id, 0),
            );
            const staged = yield* Upload.stage(claim, config.spacesStagingDir, Stream.make(pdf));
            const verified = yield* sql.withTransaction(Catalog.recordVerified(claim, staged, 0));
            yield* Upload.publish(verified, staged, config.spacesAssetsDir);
            yield* staged.release;
            return row;
          }).pipe(Effect.provide(Sqlite.layerFromPath(config.spacesDbPath)), Effect.scoped);
          const service = yield* Service.SpacesService;
          expect((yield* service.getCapability(environmentId))?.assetRecoveryPending).toBe(false);
          const saved = yield* service.finalizeAssetUpload(
            { environmentId, uploadId: stored.upload_id },
            "owner",
          );
          expect(saved.assetId).toBe(stored.asset_id);
          expect(yield* usage(config)).toEqual({
            reserved_bytes: 0,
            physical_bytes: pdf.length,
            pending_count: 0,
            active_count: 0,
          });
        }),
      ),
  );
});
