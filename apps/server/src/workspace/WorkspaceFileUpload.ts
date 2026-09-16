// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileUpload - signed workspace file uploads.
 *
 * Mirrors the chat attachment upload flow: an RPC mints a one-shot signed URL
 * and the client POSTs the bytes over HTTP, so the transfer works identically
 * for local, remote, and tunnel connections and streams to disk instead of
 * riding a WebSocket frame. Unlike attachments, the bytes land at a
 * workspace-relative path inside the project.
 *
 * @module WorkspaceFileUpload
 */
import * as NodeCrypto from "node:crypto";

import {
  PROJECT_FILE_UPLOAD_URL_TTL_MS,
  type ProjectFileCreateUploadUrlInput,
  ProjectFileUploadError,
} from "@t2code/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

export const PROJECT_FILE_UPLOAD_ROUTE_PREFIX = "/api/projects/files/upload";

// Downloads share this key, but their signed claim kind is different.
const SIGNING_SECRET_NAME = "asset-access-signing-key";

const ProjectFileUploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("project-file-upload"),
  cwd: Schema.String,
  relativePath: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
export type ProjectFileUploadClaims = typeof ProjectFileUploadClaims.Type;

const projectFileUploadClaimsJson = Schema.fromJsonString(ProjectFileUploadClaims);
const decodeProjectFileUploadClaims = Schema.decodeUnknownOption(projectFileUploadClaimsJson);
const encodeProjectFileUploadClaims = Schema.encodeSync(projectFileUploadClaimsJson);

function decodeClaims(encodedPayload: string): ProjectFileUploadClaims | null {
  try {
    return Option.getOrNull(decodeProjectFileUploadClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

const loadSigningSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

export const issueProjectFileUploadUrl = Effect.fn("WorkspaceFileUpload.issueUrl")(function* (
  input: ProjectFileCreateUploadUrlInput,
) {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const target = yield* workspacePaths
    .resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProjectFileUploadError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            failure: "workspace_path_outside_root",
            cause,
          }),
      ),
    );

  const secret = yield* loadSigningSecret.pipe(
    Effect.mapError(
      (cause) =>
        new ProjectFileUploadError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          failure: "signing_key",
          cause,
        }),
    ),
  );

  // Uploads create files; they never replace existing ones. Clobbering
  // workspace work from a drag would be a silent data-loss door.
  const fileSystem = yield* FileSystem.FileSystem;
  const existing = yield* fileSystem.stat(target.absolutePath).pipe(Effect.option);
  if (Option.isSome(existing)) {
    return yield* new ProjectFileUploadError({
      cwd: input.cwd,
      relativePath: target.relativePath,
      failure: "already_exists",
    });
  }

  const expiresAt = yield* Clock.currentTimeMillis.pipe(
    Effect.map((now) => now + PROJECT_FILE_UPLOAD_URL_TTL_MS),
  );
  const encodedPayload = base64UrlEncode(
    encodeProjectFileUploadClaims({
      version: 1,
      kind: "project-file-upload",
      cwd: input.cwd,
      relativePath: target.relativePath,
      sizeBytes: input.sizeBytes,
      expiresAt,
    }),
  );

  return {
    relativeUrl: `${PROJECT_FILE_UPLOAD_ROUTE_PREFIX}/${encodedPayload}.${signPayload(encodedPayload, secret)}`,
    expiresAt,
  };
});

export const validateProjectFileUploadToken = Effect.fn("WorkspaceFileUpload.validateToken")(
  function* (token: string) {
    const [encodedPayload, signature, unexpectedSegment] = token.split(".");
    if (!encodedPayload || !signature || unexpectedSegment) {
      return null;
    }

    const secret = yield* loadSigningSecret.pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to load the workspace file upload signing key.", { cause }),
      ),
      Effect.orElseSucceed(() => null),
    );
    if (!secret || !timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret))) {
      return null;
    }

    const claims = decodeClaims(encodedPayload);
    if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) {
      return null;
    }
    return claims;
  },
);

export type StoreProjectFileUploadResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly detail: string };

export const storeProjectFileUpload = Effect.fn("WorkspaceFileUpload.store")(function* (
  claims: ProjectFileUploadClaims,
  body: Uint8Array | HttpServerRequest.HttpServerRequest["stream"],
) {
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  if (body instanceof Uint8Array && body.byteLength !== claims.sizeBytes) {
    return {
      ok: false,
      status: 400,
      detail: `Body was ${body.byteLength} bytes, expected ${claims.sizeBytes}.`,
    } satisfies StoreProjectFileUploadResult;
  }

  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const target = yield* workspacePaths
    .resolveRelativePathWithinRoot({
      workspaceRoot: claims.cwd,
      relativePath: claims.relativePath,
    })
    .pipe(
      Effect.mapError(
        () =>
          ({
            ok: false,
            status: 400,
            detail: "Upload path resolves outside the workspace root.",
          }) satisfies StoreProjectFileUploadResult,
      ),
    );

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const existing = yield* fileSystem.stat(target.absolutePath).pipe(Effect.option);
  if (Option.isSome(existing)) {
    return {
      ok: false,
      status: 409,
      detail: "A file already exists at this path.",
    } satisfies StoreProjectFileUploadResult;
  }

  // The part file lives beside the target so the final rename stays on one
  // filesystem and is atomic where rename is.
  const partPath = `${target.absolutePath}.${NodeCrypto.randomUUID()}.part`;

  let receivedBytes = 0;
  const bodyStream = body instanceof Uint8Array ? Stream.make(body) : body;
  return yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true });
    yield* Stream.run(
      bodyStream.pipe(
        Stream.takeWhile((chunk) => {
          receivedBytes += chunk.byteLength;
          return receivedBytes <= claims.sizeBytes;
        }),
      ),
      fileSystem.sink(partPath),
    );
    if (receivedBytes !== claims.sizeBytes) {
      return {
        ok: false,
        status: 400,
        detail: `Body was ${receivedBytes} bytes, expected ${claims.sizeBytes}.`,
      } satisfies StoreProjectFileUploadResult;
    }
    yield* fileSystem.rename(partPath, target.absolutePath);
    yield* workspaceEntries.refresh(claims.cwd);
    return { ok: true } satisfies StoreProjectFileUploadResult;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("Failed to persist workspace file upload.", {
        relativePath: claims.relativePath,
        cause,
      }).pipe(
        Effect.as({
          ok: false,
          status: 500,
          detail: "Failed to persist upload.",
        } satisfies StoreProjectFileUploadResult),
      ),
    ),
    Effect.ensuring(
      fileSystem.remove(partPath, { force: true }).pipe(Effect.orElseSucceed(() => undefined)),
    ),
  );
});
