import * as Schema from "effect/Schema";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Console from "effect/Console";
import * as Tracer from "effect/Tracer";
import * as NodeUtil from "node:util";
import { makeLocalFileTracer, makeTraceSink } from "@t2code/shared/observability";
import * as ServerLogger from "../../serverLogger.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
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
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerError,
  HttpMiddleware,
} from "effect/http";

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
import * as GC from "./GC.ts";

const isControlHttpTrace = Schema.is(
  Schema.Struct({
    type: Schema.Literal("effect-span"),
    attributes: Schema.Struct({
      "url.path": Schema.String,
      "http.response.status_code": Schema.Number,
    }),
  }),
);

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
  logRequests = false,
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
      Layer.effect(HttpMiddleware.TracerDisabledWhen, HttpMiddleware.TracerDisabledWhen).pipe(
        ServerHttp.withUntracedRequests,
      ),
    ).pipe(Layer.provideMerge(NodeServices.layer)),
    scope,
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(
      ServerHttp.layerSpacesUploadRoute,
      ServerHttp.layerAssetRoute,
      HttpRouter.add("GET", "/api/assets-info", HttpServerResponse.text("public control")),
      HttpRouter.add(
        "GET",
        "/api/assets/:token/trace-error",
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
          Effect.fail(
            new HttpServerError.HttpServerError({
              reason: new HttpServerError.InternalError({
                request,
                description: "Synthetic response failure",
              }),
            }),
          ),
        ),
      ),
    ).pipe(
      Layer.provide(ServerHttp.layerBrowserApiCors),
      Layer.provide(ServerHttp.layerHttpCompression),
      ServerHttp.withUntracedRequests,
      Layer.provideMerge(Layer.succeedContext(context)),
    ),
    { disableLogger: !logRequests, middleware: ServerHttp.assetRequestPrivacy },
  );
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const request = (relative: string, init?: RequestInit) =>
    Effect.contextWith((current: Context.Context<never>) =>
      Effect.promise(() => handler(new Request(`http://assets.test${relative}`, init), current)),
    );
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
  it.effect(
    "keeps bearer paths and queries out of real HTTP traces and access logs without suppressing unrelated requests",
    () =>
      fixture(
        ({ config, request }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const filePath = config.serverTracePath;
            const options = { filePath, maxBytes: 1_048_576, maxFiles: 1, batchWindowMs: 10_000 };
            const sink = yield* makeTraceSink(options);
            const tracer = yield* makeLocalFileTracer({ ...options, sink });
            const printed: string[] = [];
            const testConsole = {
              ...globalThis.console,
              log: (...args: ReadonlyArray<unknown>) => {
                printed.push(NodeUtil.format(...args));
              },
            } satisfies Console.Console;
            const secrets = ["SYNTHETIC_ASSET_QUERY", "SYNTHETIC_ASSET_BEARER"];
            yield* Effect.gen(function* () {
              const service = yield* Service.SpacesService;
              const grant = yield* service.createAssetUpload(
                common("trace-policy"),
                "trace-fixture",
              );
              secrets.push(grant.relativeUrl.split("/").at(-1)!);
              for (const path of [
                grant.relativeUrl,
                grant.relativeUrl.replace(
                  "/api/spaces/assets/upload",
                  "/api/spaces//assets/upload",
                ),
              ]) {
                const preflight = yield* request(`${path}?query=${secrets[0]}`, {
                  method: "OPTIONS",
                  headers: {
                    origin: "https://app.t2.codes",
                    "access-control-request-method": "POST",
                    "access-control-request-headers": "content-type",
                  },
                });
                expect(preflight.status).toBe(204);
                expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
                expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
                expect(preflight.headers.get("access-control-allow-headers")).toContain(
                  "content-type",
                );
                expect(preflight.headers.get("access-control-max-age")).toBe("600");
              }
              expect(
                (yield* request(grant.relativeUrl, {
                  method: "POST",
                  headers: { "content-length": String(pdf.length) },
                  body: new Uint8Array(pdf),
                })).status,
              ).toBe(204);
              const signed = yield* issueAssetUrl({
                resource: { _tag: "spaces-asset", environmentId, assetId: grant.assetId },
              });
              secrets.push(signed.relativeUrl.split("/")[3]!);
              const target = `${signed.relativeUrl}?query=${secrets[0]}`;
              for (const path of [target, target.replace("/api/assets", "/api//assets")]) {
                const preflight = yield* request(path, {
                  method: "OPTIONS",
                  headers: {
                    origin: "https://app.t2.codes",
                    "access-control-request-method": "GET",
                    "access-control-request-headers": "range",
                  },
                });
                expect(preflight.status).toBe(204);
                expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
                expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
              }
              const full = yield* request(target);
              expect(full.status).toBe(200);
              expect(new Uint8Array(yield* Effect.promise(() => full.arrayBuffer()))).toEqual(pdf);
              expect(full.headers.get("cache-control")).toContain("private");
              const exposed = full.headers.get("access-control-expose-headers")?.split(",");
              expect(exposed).toEqual([
                "accept-ranges",
                "content-range",
                "content-length",
                "content-encoding",
                "etag",
              ]);
              const head = yield* request(target, { method: "HEAD" });
              expect(head.status).toBe(200);
              expect(yield* Effect.promise(() => head.text())).toBe("");
              const range = yield* request(target, { headers: { range: "bytes=0-4" } });
              expect(range.status).toBe(206);
              expect(new Uint8Array(yield* Effect.promise(() => range.arrayBuffer()))).toEqual(
                pdf.subarray(0, 5),
              );
              expect((yield* request(target, { headers: { range: "bytes=999999-" } })).status).toBe(
                416,
              );
              expect((yield* request(target, { method: "POST" })).status).toBe(404);
              for (const [path, status] of [
                [`/api/assets/${secrets[1]}/missing.pdf?query=${secrets[0]}`, 404],
                [`/api/assets/${secrets[1]}/trace-error?query=${secrets[0]}`, 500],
                [`/api/assets?query=${secrets[0]}`, 404],
              ] as const)
                expect((yield* request(path)).status).toBe(status);
              for (const [prefix, status] of [
                ["/api//assets", 404],
                ["//api///assets", 404],
                ["/API/ASSETS", 200],
                ["/%61pi/ass%65ts", 404],
              ] as const) {
                const alias = target.replace("/api/assets", prefix);
                for (const method of ["GET", "HEAD", "POST"] as const) {
                  const response = yield* request(alias, { method });
                  expect(response.status).toBe(method === "POST" ? 404 : status);
                  yield* Effect.promise(() => response.arrayBuffer());
                }
                const ranged = yield* request(alias, { headers: { range: "bytes=0-4" } });
                expect(ranged.status).toBe(status === 200 ? 206 : status);
                yield* Effect.promise(() => ranged.arrayBuffer());
              }
              for (const prefix of [
                "/api/spaces//assets/upload",
                "//api///spaces/assets//upload",
                "/%61pi/spaces/ass%65ts/upload",
              ]) {
                const alias = `${grant.relativeUrl.replace("/api/spaces/assets/upload", prefix)}?query=${secrets[0]}`;
                expect(
                  (yield* request(alias, {
                    method: "POST",
                    headers: { "content-length": String(pdf.length) },
                    body: new Uint8Array(pdf),
                  })).status,
                ).toBe(404);
              }
              expect(
                (yield* request(`/API/SPACES/ASSETS/UPLOAD/${secrets[1]}?query=${secrets[0]}`, {
                  method: "POST",
                })).status,
              ).toBe(404);
              expect((yield* request(`/api/assets;query=${secrets[0]}`)).status).toBe(404);
              for (const path of ["/api/assets%2Finfo", "/api/spaces//assets/upload-info"]) {
                expect((yield* request(`${path}?query=public`)).status).toBe(404);
              }
              const aliasControl = yield* request("/api//assets-info?query=public");
              expect(aliasControl.status).toBe(200);
              expect(yield* Effect.promise(() => aliasControl.text())).toBe("public control");
              const control = yield* request("/api/assets-info?query=public");
              expect(control.status).toBe(200);
              expect(yield* Effect.promise(() => control.text())).toBe("public control");
              const controlPreflight = yield* request("/api/assets-info/preflight?query=public", {
                method: "OPTIONS",
                headers: {
                  origin: "https://app.t2.codes",
                  "access-control-request-method": "GET",
                  "access-control-request-headers": "range",
                },
              });
              expect(controlPreflight.status).toBe(204);
              expect(controlPreflight.headers.get("access-control-allow-origin")).toBe("*");
            }).pipe(
              Effect.provide(
                ServerLogger.layer.pipe(
                  Layer.provide(Config.layer({ ...config, logLevel: "Info" })),
                  Layer.provide(NodeHttpClient.layerUndici),
                ),
              ),
              Effect.provideService(Tracer.Tracer, tracer),
              Effect.provideService(Console.Console, testConsole),
            );
            yield* sink.flush;
            const text = yield* fs.readFileString(filePath);
            const logs = printed.join("\n");
            for (const secret of secrets) {
              expect(text.includes(secret), "bearer material persisted in HTTP trace records").toBe(
                false,
              );
              expect(logs.includes(secret), "bearer material entered HTTP access/error logs").toBe(
                false,
              );
            }
            const records = text
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line): unknown => JSON.parse(line));
            const httpRecords = records.filter(isControlHttpTrace);
            for (const [path, status] of [
              ["/api/assets-info", 200],
              ["/api/assets-info/preflight", 204],
              ["/api//assets-info", 200],
              ["/api/assets%2Finfo", 404],
              ["/api/spaces//assets/upload-info", 404],
            ] as const) {
              expect(
                httpRecords.some(
                  (record) =>
                    record.attributes["url.path"] === path &&
                    record.attributes["http.response.status_code"] === status,
                ),
              ).toBe(true);
              expect(logs.includes(path)).toBe(true);
            }
          }),
        true,
        true,
      ),
  );

  it.effect("keeps healthy uploads readable through repeated complete sanity audits", () =>
    fixture(({ request }) =>
      Effect.gen(function* () {
        const service = yield* Service.SpacesService;
        const minted = yield* service.createAssetUpload(common("healthy-audit"), "owner");
        expect(
          (yield* request(minted.relativeUrl, {
            method: "POST",
            headers: { "content-length": String(pdf.length) },
            body: new Uint8Array(pdf),
          })).status,
        ).toBe(204);
        const asset = yield* service.finalizeAssetUpload(
          { environmentId, uploadId: minted.uploadId },
          "owner",
        );
        const library = yield* service.listSpaces({ environmentId });
        const created = yield* service.createPage({
          environmentId,
          receiptEpoch: library.mutationAdmission.epoch,
          mutationId: "audit-page",
          spaceId: library.defaultSpaceId,
          baseRootOrderRevision: 0,
          title: "Healthy audit",
        });
        if (created.status !== "saved") return yield* Effect.die("Expected audit page");
        yield* service.applyBlockBatch({
          environmentId,
          receiptEpoch: library.mutationAdmission.epoch,
          mutationId: "audit-pin",
          pageId: created.page.id,
          baseRevision: 0,
          generation: 0,
          mutations: [
            {
              kind: "insert",
              block: {
                id: C.SpaceBlockId.make("audit"),
                parentId: null,
                order: "1".padStart(32, "0"),
                type: "pdf",
                version: 1,
                content: { assetId: asset.assetId },
              },
            },
          ],
        });
        for (const cycle of [0, 1]) {
          if (cycle) yield* TestClock.adjust("25 hours");
          const signed = yield* issueAssetUrl({
            resource: { _tag: "spaces-asset", environmentId, assetId: asset.assetId },
          });
          const beforeAudit = yield* request(signed.relativeUrl);
          expect(beforeAudit.status).toBe(200);
          expect(new Uint8Array(yield* Effect.promise(() => beforeAudit.arrayBuffer()))).toEqual(
            pdf,
          );
          for (const _step of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) yield* service.maintainAssets;
          expect(
            yield* service.getAssetMetadata({ environmentId, assetId: asset.assetId }),
          ).toEqual(asset);
          const response = yield* request(signed.relativeUrl);
          expect(response.status).toBe(200);
          expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(pdf);
          expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
            catalogPending: false,
            unresolved: false,
            gcEnabled: true,
          });
        }
      }),
    ),
  );

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
          const capability = yield* service.getCapability(environmentId);
          expect(capability?.features?.assets).toBe(true);
          expect(capability?.features?.contextCapture).toBe(true);
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
          const library = yield* service.listSpaces({ environmentId });
          const receiptEpoch = library.mutationAdmission.epoch;
          const page = yield* service.createPage({
            environmentId,
            receiptEpoch,
            mutationId: `page-${kind}`,
            spaceId: library.defaultSpaceId,
            baseRootOrderRevision: 0,
            title: "Media",
          });
          if (page.status !== "saved") return yield* Effect.die("Expected page");
          const block = {
            id: C.SpaceBlockId.make(`block-${kind}`),
            parentId: null,
            order: "1".padStart(32, "0"),
            type: kind,
            version: 1,
            content: { assetId: saved.assetId, caption: [{ text: "before", marks: [] }] },
          };
          for (const [revision, caption] of ["before", "after"].entries()) {
            expect(
              (yield* service.applyBlockBatch({
                environmentId,
                receiptEpoch,
                mutationId: `caption-${kind}-${revision}`,
                pageId: page.page.id,
                baseRevision: revision,
                generation: revision,
                mutations: [
                  {
                    kind: revision === 0 ? "insert" : "replace",
                    block: {
                      ...block,
                      content: { ...block.content, caption: [{ text: caption, marks: [] }] },
                    },
                  },
                ],
              })).status,
            ).toBe("saved");
          }
          const captured = yield* service.captureContextSnapshot({
            environmentId,
            contextId: `media-${kind}`,
            target: { kind: "block", blockId: block.id },
          });
          if (captured.status !== "captured") return yield* Effect.die("Expected media capture");
          expect(captured.record.snapshot.text).toBe(`[${kind} ${saved.assetId}] after`);
          expect(captured.record.snapshot.sources).toEqual([
            {
              environmentId,
              spaceId: page.page.spaceId,
              pageId: page.page.id,
              revision: 2,
              blockIds: [block.id],
            },
          ]);
          expect(
            (yield* service.readBlocks({ environmentId, pageId: page.page.id, revision: 2 }))
              .blocks,
          ).toEqual([
            { ...block, content: { ...block.content, caption: [{ text: "after", marks: [] }] } },
          ]);
          expect(
            yield* service.getAssetMetadata({ environmentId, assetId: saved.assetId }),
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
            const owner = "10000000-0000-4000-8000-000000000000";
            yield* sql.withTransaction(GC.initializeOwner(owner));
            const claim = yield* sql.withTransaction(
              Catalog.claim(row.caller_id, row.upload_id, 0, owner),
            );
            const staged = yield* Upload.stage(
              claim,
              config.spacesStagingDir,
              Stream.make(pdf),
              (identity) => sql.withTransaction(Catalog.recordCreated(claim, identity)),
            );
            yield* sql.withTransaction(GC.retireOwner(owner));
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

it.effect(
  "keeps old signed handles revoked after collection and digest reuse while new bearer reads retain HEAD and ranges",
  () =>
    fixture(({ request }) =>
      Effect.gen(function* () {
        const service = yield* Service.SpacesService;
        const receive = Effect.fn("SpacesAssetsPublicTest.collectibleUpload")(function* (
          id: string,
        ) {
          const intent = yield* service.createAssetUpload(common(id), "owner");
          expect(
            (yield* request(intent.relativeUrl, {
              method: "POST",
              headers: { "content-length": String(pdf.length) },
              body: new Uint8Array(pdf),
            })).status,
          ).toBe(204);
          return yield* service.finalizeAssetUpload(
            { environmentId, uploadId: intent.uploadId },
            "owner",
          );
        });
        const first = yield* receive("old-generation");
        for (const _step of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) yield* service.maintainAssets;
        yield* TestClock.adjust("24 hours");
        const old = yield* issueAssetUrl({
          resource: { _tag: "spaces-asset", environmentId, assetId: first.assetId },
        });
        expect((yield* request(old.relativeUrl)).status).toBe(200);
        yield* service.maintainAssets;
        expect((yield* request(old.relativeUrl)).status).toBe(404);
        const next = yield* receive("new-generation");
        expect(next.digest).toBe(first.digest);
        const signed = yield* issueAssetUrl({
          resource: { _tag: "spaces-asset", environmentId, assetId: next.assetId },
        });
        expect((yield* request(old.relativeUrl)).status).toBe(404);
        const head = yield* request(signed.relativeUrl, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("content-length")).toBe(String(pdf.length));
        expect(yield* Effect.promise(() => head.text())).toBe("");
        const range = yield* request(signed.relativeUrl, { headers: { range: "bytes=0-4" } });
        expect(range.status).toBe(206);
        expect(range.headers.get("content-range")).toBe(`bytes 0-4/${pdf.length}`);
        expect(new Uint8Array(yield* Effect.promise(() => range.arrayBuffer()))).toEqual(
          pdf.subarray(0, 5),
        );
      }),
    ),
);
