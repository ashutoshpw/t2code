// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import {
  PROJECT_FILE_UPLOAD_ROUTE_PREFIX,
  issueProjectFileUploadUrl,
  storeProjectFileUpload,
  validateProjectFileUploadToken,
} from "./WorkspaceFileUpload.ts";

const testLayer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-file-upload-" })),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeWorkspaceRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t2code-project-file-upload-",
  });
  return root;
});

const mintToken = Effect.fn("mintToken")(function* (cwd: string, relativePath: string) {
  const issued = yield* issueProjectFileUploadUrl({ cwd, relativePath, sizeBytes: 6 });
  const token = issued.relativeUrl.slice(`${PROJECT_FILE_UPLOAD_ROUTE_PREFIX}/`.length);
  const claims = yield* validateProjectFileUploadToken(token);
  if (!claims) {
    throw new Error("Expected valid upload claims.");
  }
  return { issued, claims };
});

describe("WorkspaceFileUpload", () => {
  it.effect("signs the target path and validates the upload token", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspaceRoot;
      const { issued, claims } = yield* mintToken(cwd, "assets/logo.png");

      expect(issued.relativeUrl.startsWith(`${PROJECT_FILE_UPLOAD_ROUTE_PREFIX}/`)).toBe(true);
      expect(claims).toMatchObject({
        kind: "project-file-upload",
        relativePath: "assets/logo.png",
        sizeBytes: 6,
      });
      expect(NodePath.isAbsolute(claims.cwd)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects tampered and expired upload tokens", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspaceRoot;
      const issued = yield* issueProjectFileUploadUrl({
        cwd,
        relativePath: "logo.png",
        sizeBytes: 6,
      });
      const token = issued.relativeUrl.slice(`${PROJECT_FILE_UPLOAD_ROUTE_PREFIX}/`.length);
      const [payload, signature] = token.split(".");

      expect(yield* validateProjectFileUploadToken(`${payload}x.${signature}`)).toBeNull();
      expect(yield* validateProjectFileUploadToken(`${token}.extra`)).toBeNull();
      expect(yield* validateProjectFileUploadToken("garbage")).toBeNull();

      yield* TestClock.adjust("11 minutes");
      expect(yield* validateProjectFileUploadToken(token)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects upload paths outside the workspace root", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspaceRoot;
      const failure = yield* issueProjectFileUploadUrl({
        cwd,
        relativePath: "../outside.png",
        sizeBytes: 6,
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "ProjectFileUploadError",
        failure: "workspace_path_outside_root",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses to replace an existing file", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspaceRoot;
      NodeFS.writeFileSync(NodePath.join(cwd, "logo.png"), Buffer.from("original"));

      const failure = yield* issueProjectFileUploadUrl({
        cwd,
        relativePath: "logo.png",
        sizeBytes: 6,
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "ProjectFileUploadError", failure: "already_exists" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("stores the bytes at the workspace path and refreshes the index", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspaceRoot;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const { claims } = yield* mintToken(cwd, "assets/logo.png");

      expect(yield* storeProjectFileUpload(claims, new Uint8Array([1, 2, 3]))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(
        yield* storeProjectFileUpload(
          claims,
          Stream.make(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
        ),
      ).toEqual({ ok: true });

      expect(NodeFS.readFileSync(NodePath.join(cwd, "assets/logo.png"))).toEqual(
        Buffer.from([1, 2, 3, 4, 5, 6]),
      );
      expect(NodeFS.readdirSync(NodePath.join(cwd, "assets"))).toEqual(["logo.png"]);
      // The second store attempt must not clobber the freshly written file.
      expect(yield* storeProjectFileUpload(claims, new Uint8Array(6))).toMatchObject({
        ok: false,
        status: 409,
      });
      expect(NodeFS.readFileSync(NodePath.join(cwd, "assets/logo.png"))).toEqual(
        Buffer.from([1, 2, 3, 4, 5, 6]),
      );

      const entries = yield* workspaceEntries.list({ cwd, directoryPath: "" });
      expect(entries.entries.map((entry) => entry.path)).toContain("assets");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes partial uploads that exceed their signed size", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspaceRoot;
      const { claims } = yield* mintToken(cwd, "logo.png");

      expect(yield* storeProjectFileUpload(claims, Stream.make(new Uint8Array(7)))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(NodeFS.readdirSync(cwd)).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );
});
