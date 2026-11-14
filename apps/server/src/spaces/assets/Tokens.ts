import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../../auth/utils.ts";
import type { UploadRow } from "./Catalog.ts";

export const UPLOAD_ROUTE_PREFIX = "/api/spaces/assets/upload";
const Grant = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("spaces-upload"),
  environmentId: EnvironmentId,
  uploadId: C.SpaceAssetUploadId,
  callerId: Schema.String,
  fingerprint: Schema.String,
  expectedBytes: Schema.Int,
  mimeType: C.SpaceAssetMimeType,
  mediaKind: Schema.Literals(["image", "pdf", "video"]),
  expiresAt: Schema.Number,
});
const codec = Schema.fromJsonString(Grant);
const encode = Schema.encodeSync(codec);
const decode = Schema.decodeUnknownOption(codec);
const secret = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  return yield* store
    .getOrCreateRandom("asset-access-signing-key", 32)
    .pipe(Effect.mapError(() => new C.SpacesUnavailableError({ stage: "storage" })));
});
export const issue = Effect.fn("SpacesAssets.issueUploadGrant")(function* (
  environmentId: EnvironmentId,
  row: UploadRow,
) {
  const key = yield* secret;
  const payload = base64UrlEncode(
    encode({
      version: 1,
      kind: "spaces-upload",
      environmentId,
      uploadId: C.SpaceAssetUploadId.make(row.upload_id),
      callerId: row.caller_id,
      fingerprint: row.fingerprint,
      expectedBytes: row.expected_bytes,
      mimeType: row.mime_type,
      mediaKind: row.media_kind,
      expiresAt: row.expires_at_ms,
    }),
  );
  return `${UPLOAD_ROUTE_PREFIX}/${payload}.${signPayload(payload, key)}`;
});
export const read = Effect.fn("SpacesAssets.readUploadGrant")(function* (token: string) {
  if (token.length > 4096) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const key = yield* secret;
  if (!timingSafeEqualBase64Url(signature, signPayload(payload, key))) return null;
  const grant = yield* Effect.try({
    try: () => Option.getOrNull(decode(base64UrlDecodeUtf8(payload))),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));
  if (!grant || grant.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
  return grant;
});
