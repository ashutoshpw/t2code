import {
  SPACE_PAGE_SHARE_PAGE_PATH,
  SPACE_PAGE_SHARE_TTL_MS,
  SpacePageShareError,
  SpacePageShareId,
  type SpacePageShareCreateInput,
  type SpacePageShareCreateResult,
  type SpacePageShareGetInput,
  type SpacePageShareGetResult,
  type SpacePageShareStopInput,
  type SpaceSharedPage,
} from "@t2code/contracts";
import type * as C from "@t2code/contracts/spaces";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";

import { base64UrlEncode, signPayload, timingSafeEqualBase64Url } from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpacesService from "./SpacesService.ts";

const SIGNING_SECRET_NAME = "space-page-share-signing-key";
const SHARE_ID_BYTES = 16;
const SIGNATURE_BYTES = 16;

const ACCESS_MESSAGES = {
  invalid: "This page link is not valid.",
  inactive: "This page link has ended.",
  unavailable: "This page is not available.",
} as const;

/** What a viewer is told. The message comes from `reason`, never from a cause. */
export class SpacePageShareAccessError extends Schema.TaggedError<SpacePageShareAccessError>()(
  "SpacePageShareAccessError",
  { reason: Schema.Literals(["invalid", "inactive", "unavailable"]) },
) {
  override get message(): string {
    return ACCESS_MESSAGES[this.reason];
  }
}

const inactive = new SpacePageShareAccessError({ reason: "inactive" });
const unavailable = new SpacePageShareAccessError({ reason: "unavailable" });

const shareError = (error: C.SpaceServiceError) =>
  new SpacePageShareError({
    reason:
      error._tag === "SpaceNotFoundError" ||
      error._tag === "SpaceValidationError" ||
      error._tag === "SpacesDisabledError"
        ? "page_unavailable"
        : "failed",
  });

/** A truncated HMAC keeps links short. 128 bits is still far beyond guessing range. */
const signature = (shareId: string, key: Uint8Array) =>
  base64UrlEncode(
    Buffer.from(signPayload(`space-page-share:${shareId}`, key), "base64url").subarray(
      0,
      SIGNATURE_BYTES,
    ),
  );

export class SpacePageShareService extends Context.Service<
  SpacePageShareService,
  {
    /** Replaces the page's link, which ends the previous one. */
    readonly create: (
      input: SpacePageShareCreateInput,
    ) => Effect.Effect<SpacePageShareCreateResult, SpacePageShareError>;
    readonly stop: (input: SpacePageShareStopInput) => Effect.Effect<void, SpacePageShareError>;
    readonly get: (
      input: SpacePageShareGetInput,
    ) => Effect.Effect<SpacePageShareGetResult, SpacePageShareError>;
    /**
     * Checks a link against its live share: same id, not expired, Labs setting on, Connect still
     * serving the host, and the page being the shared root or a live descendant of it.
     */
    readonly page: (
      token: string,
      pageId?: C.SpacePageId,
    ) => Effect.Effect<SpaceSharedPage, SpacePageShareAccessError>;
    /** An asset that a live block of an authorized page references. */
    readonly asset: (
      token: string,
      pageId: C.SpacePageId,
      assetId: C.SpaceAssetId,
    ) => Effect.Effect<SpacesService.ResolvedAssetFile, SpacePageShareAccessError, Scope.Scope>;
  }
>()("@t2code/cli/spaces/PageShareService/SpacePageShareService") {}

const make = Effect.gen(function* () {
  const spaces = yield* SpacesService.SpacesService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const managedEndpoint = yield* CloudManagedEndpointRuntime;
  const crypto = yield* Crypto.Crypto;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingKey = yield* Effect.cached(
    secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(Effect.orDie),
  );

  const connectHostname = managedEndpoint.inspectConnector.pipe(
    Effect.map((facts) => facts?.hostname ?? null),
  );
  const sharingEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.spacesPageSharingEnabled),
    Effect.orElseSucceed(() => false),
  );

  const credential = (shareId: SpacePageShareId) =>
    Effect.map(signingKey, (key) => `${shareId}.${signature(shareId, key)}`);
  const verify = Effect.fn("SpacePageShareService.verify")(function* (token: string) {
    const [shareId, tag, extra] = token.split(".");
    if (!shareId || !tag || extra !== undefined) return null;
    const key = yield* signingKey;
    return timingSafeEqualBase64Url(tag, signature(shareId, key))
      ? SpacePageShareId.make(shareId)
      : null;
  });

  const create = Effect.fn("SpacePageShareService.create")(function* (
    input: SpacePageShareCreateInput,
  ) {
    if (!(yield* sharingEnabled)) return yield* new SpacePageShareError({ reason: "disabled" });
    const host = yield* connectHostname;
    if (host === null) return yield* new SpacePageShareError({ reason: "connect_unavailable" });
    const id = SpacePageShareId.make(
      base64UrlEncode(yield* crypto.randomBytes(SHARE_ID_BYTES).pipe(Effect.orDie)),
    );
    const now = yield* DateTime.now;
    const share = {
      id,
      pageId: input.pageId,
      host,
      createdAt: DateTime.formatIso(now),
      expiresAt: DateTime.formatIso(DateTime.add(now, { milliseconds: SPACE_PAGE_SHARE_TTL_MS })),
    };
    yield* spaces.replacePageShare(share).pipe(Effect.mapError(shareError));
    return { url: `https://${host}${SPACE_PAGE_SHARE_PAGE_PATH}#${yield* credential(id)}`, share };
  });

  const stop = Effect.fn("SpacePageShareService.stop")(function* (input: SpacePageShareStopInput) {
    yield* spaces.stopPageShare(input.pageId).pipe(Effect.mapError(shareError));
  });

  const get = Effect.fn("SpacePageShareService.get")(function* (input: SpacePageShareGetInput) {
    const share = yield* spaces
      .findPageShare({ pageId: input.pageId })
      .pipe(Effect.mapError(shareError));
    return {
      link:
        share === null
          ? null
          : {
              url: `https://${share.host}${SPACE_PAGE_SHARE_PAGE_PATH}#${yield* credential(share.id)}`,
              share,
            },
    };
  });

  const authorize = Effect.fn("SpacePageShareService.authorize")(function* (
    token: string,
    requested: C.SpacePageId | undefined,
  ) {
    const shareId = yield* verify(token);
    if (shareId === null) return yield* new SpacePageShareAccessError({ reason: "invalid" });
    const share = yield* spaces.findPageShare({ shareId }).pipe(Effect.mapError(() => inactive));
    const now = yield* DateTime.now;
    if (
      !(yield* sharingEnabled) ||
      share === null ||
      DateTime.toEpochMillis(now) >= Date.parse(share.expiresAt) ||
      (yield* connectHostname) !== share.host
    ) {
      return yield* inactive;
    }
    const pageId = requested ?? share.pageId;
    const locate = (target: C.SpacePageId) =>
      spaces
        .locateSharedPage({ rootPageId: share.pageId, pageId: target })
        .pipe(Effect.mapError(() => inactive));
    const breadcrumb = yield* locate(pageId);
    if (breadcrumb !== null) return { share, pageId, breadcrumb };
    // A trashed or deleted root ends the link; any other miss is a page outside the tree.
    return yield* pageId === share.pageId || (yield* locate(share.pageId)) === null
      ? inactive
      : unavailable;
  });

  const page = Effect.fn("SpacePageShareService.page")(function* (
    token: string,
    requested?: C.SpacePageId,
  ) {
    const { share, pageId, breadcrumb } = yield* authorize(token, requested);
    return yield* spaces
      .readSharedPage({ rootPageId: share.pageId, expiresAt: share.expiresAt, pageId, breadcrumb })
      .pipe(Effect.mapError(() => unavailable));
  });

  const asset = Effect.fn("SpacePageShareService.asset")(function* (
    token: string,
    pageId: C.SpacePageId,
    assetId: C.SpaceAssetId,
  ) {
    yield* authorize(token, pageId);
    return yield* spaces
      .resolveSharedAssetFile({ pageId, assetId })
      .pipe(Effect.mapError(() => unavailable));
  });

  return SpacePageShareService.of({ create, stop, get, page, asset });
});

export const layer = Layer.effect(SpacePageShareService, make);
