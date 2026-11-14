import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import { EnvironmentId } from "../packages/contracts/src/index.ts";
import * as Config from "../apps/server/src/config.ts";
import * as Secrets from "../apps/server/src/auth/ServerSecretStore.ts";
import * as Identity from "../apps/server/src/environment/ServerEnvironment.ts";
import * as Settings from "../apps/server/src/serverSettings.ts";
import * as Service from "../apps/server/src/spaces/SpacesService.ts";
import * as WorkspacePaths from "../apps/server/src/workspace/WorkspacePaths.ts";
import { issueAssetUrl, resolveAsset } from "../apps/server/src/assets/AssetAccess.ts";
import { promiseRunner } from "./spaces-mobile.test-support.mjs";
import {
  MobileSpaceImageBudget,
  MobileSpaceImageViewer,
} from "../apps/mobile/src/features/spaces/media.ts";

it.effect.each(["image", "pdf", "video"])(
  "opens real streamed/finalized %s using actual metadata and signed reads, expires then remints, and reauthorizes original download intent",
  (kind) =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("native-image");
      const configContext = yield* Layer.buildWithScope(
        Config.ServerConfig.layerTest(process.cwd(), { prefix: "spaces-mobile-image-" }),
        yield* Effect.scope,
      );
      const config = Context.get(configContext, Config.ServerConfig);
      const configLayer = Layer.succeedContext(configContext);
      const spaces = Service.layerFromPath(config.spacesDbPath, {
        assetsDir: config.spacesAssetsDir,
        stagingDir: config.spacesStagingDir,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Settings.layerTest({ spacesEnabled: true }),
            Layer.succeed(Identity.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(environmentId),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* Service.SpacesService,
          fs = yield* FileSystem.FileSystem;
        const run = yield* promiseRunner();
        const png = new Uint8Array(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
            "base64",
          ),
        );
        const original =
          kind === "image"
            ? png
            : kind === "pdf"
              ? new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n")
              : new Uint8Array([
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
        const mimeType =
          kind === "image" ? "image/png" : kind === "pdf" ? "application/pdf" : "video/mp4";
        const reservation = yield* service.createAssetUpload(
          {
            environmentId,
            requestId: "original-image",
            expectedBytes: original.length,
            mediaKind: kind,
            mimeType,
            name: `original.${kind === "image" ? "png" : kind === "pdf" ? "pdf" : "mp4"}`,
          },
          "test-owner",
        );
        yield* service.receiveAssetUpload(
          reservation.relativeUrl.split("/").at(-1),
          String(original.length),
          Stream.make(original),
        );
        const asset = yield* service.finalizeAssetUpload(
          { environmentId, uploadId: reservation.uploadId },
          "test-owner",
        );
        const capability = yield* service.getCapability(environmentId);
        let now = yield* Clock.currentTimeMillis;
        let allowed = true;
        const resolve = (url) => {
          const path = new URL(url).pathname.split("/");
          return resolveAsset(path[3], path.slice(4).join("/"));
        };
        const shares = [];
        const viewer = new MobileSpaceImageViewer(
          {
            budget: new MobileSpaceImageBudget(),
            now: () => now,
            access: () => ({
              capability,
              httpBaseUrl: "https://selected.example/",
              current: () => allowed,
            }),
            metadata: (id) => run(service.getAssetMetadata({ environmentId, assetId: id })),
            mint: (id, disposition) =>
              run(
                issueAssetUrl({
                  resource: { _tag: "spaces-asset", environmentId, assetId: id, disposition },
                }),
              ),
            share: async (input) => {
              if (input.current()) {
                const resolved = await run(resolve(input.url));
                shares.push({
                  download: resolved.download,
                  bytes: new Uint8Array(await run(fs.readFile(resolved.path))),
                });
              }
            },
          },
          kind,
        );
        const block = {
          id: "native-image-block",
          parentId: null,
          order: "a",
          version: 1,
          type: kind,
          content: { assetId: asset.assetId },
        };
        yield* Effect.promise(() => viewer.open(block, () => true));
        const first = viewer.url();
        expect(first).not.toBeNull();
        const resolved = yield* resolve(first);
        expect(resolved.immutableDigest).toBe(asset.digest);
        expect(new Uint8Array(yield* fs.readFile(resolved.path))).toEqual(original);
        yield* TestClock.adjust("2 hours");
        now = yield* Clock.currentTimeMillis;
        expect(viewer.url()).toBeNull();
        expect(yield* resolve(first)).toBeNull();
        yield* Effect.promise(() => viewer.refresh());
        expect(viewer.url()).not.toBe(first);
        yield* Effect.promise(() => viewer.share());
        expect(shares).toEqual([{ download: true, bytes: original }]);
        allowed = false;
        yield* Effect.promise(() => viewer.refresh());
        expect(viewer.url()).toBeNull();
        viewer.close();
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            spaces,
            Secrets.layer.pipe(Layer.provide(configLayer)),
            WorkspacePaths.layer,
            configLayer,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
