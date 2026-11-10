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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

import { base64UrlEncode, signPayload, timingSafeEqualBase64Url } from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as SpacesService from "./SpacesService.ts";

const SIGNING_SECRET_NAME = "space-page-share-signing-key";
const SHARE_ID_BYTES = 16;
const SIGNATURE_BYTES = 16;

const ACCESS_MESSAGES = {
  invalid: "This page link is not valid.",
  inactive: "This page link has ended.",
  unavailable: "This page is not available.",
  busy: "Too many requests. Try again shortly.",
  failed: "This page could not be loaded. Try again shortly.",
} as const;

/** What a viewer is told. The message comes from `reason`, never from a cause. */
export class SpacePageShareAccessError extends Schema.TaggedError<SpacePageShareAccessError>()(
  "SpacePageShareAccessError",
  { reason: Schema.Literals(["invalid", "inactive", "unavailable", "busy", "failed"]) },
) {
  override get message(): string {
    return ACCESS_MESSAGES[this.reason];
  }
}

const inactive = new SpacePageShareAccessError({ reason: "inactive" });
const unavailable = new SpacePageShareAccessError({ reason: "unavailable" });
const busy = new SpacePageShareAccessError({ reason: "busy" });
const failed = new SpacePageShareAccessError({ reason: "failed" });
const MAX_CONCURRENT_VIEWER_REQUESTS = 32;

const shareError = (error: C.SpaceServiceError) =>
  new SpacePageShareError({
    reason:
      error._tag === "SpaceNotFoundError" ||
      error._tag === "SpaceValidationError" ||
      error._tag === "SpacesDisabledError"
        ? "page_unavailable"
        : "failed",
  });

/** Errors that mean the viewer asked for something that is not there; anything else is a fault and is logged. */
const accessFailure = (expected: SpacePageShareAccessError) => (error: C.SpaceServiceError) => {
  const gone =
    error._tag === "SpaceNotFoundError" ||
    error._tag === "SpacesDisabledError" ||
    (error._tag === "SpaceValidationError" &&
      (error.reason === "trashed" || error.reason === "invalid_cursor")) ||
    (error._tag === "SpaceAssetError" &&
      (error.reason === "not_found" || error.reason === "missing_file"));
  return gone
    ? Effect.succeed(expected)
    : Effect.logError("Shared page request failed", { error: error._tag }).pipe(Effect.as(failed));
};

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
      cursor?: string,
    ) => Effect.Effect<SpaceSharedPage, SpacePageShareAccessError>;
    /** An asset that a live block of an authorized page references. */
    readonly asset: (
      token: string,
      pageId: C.SpacePageId | undefined,
      assetId: C.SpaceAssetId,
    ) => Effect.Effect<SpacesService.ResolvedAssetFile, SpacePageShareAccessError, Scope.Scope>;
  }
>()("@t2code/cli/spaces/PageShareService/SpacePageShareService") {}

const make = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const spaces = yield* SpacesService.SpacesService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const managedEndpoint = yield* CloudManagedEndpointRuntime;
  const random = yield* SecureRandom.SecureRandom;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const viewers = yield* Semaphore.make(MAX_CONCURRENT_VIEWER_REQUESTS);
  const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    viewers
      .withPermitsIfAvailable(1)(effect)
      .pipe(
        Effect.flatMap((result) => (Option.isSome(result) ? Effect.succeed(result.value) : busy)),
      );
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
      base64UrlEncode(yield* random.randomBytes(SHARE_ID_BYTES).pipe(Effect.orDie)),
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
    const resolved = yield* spaces
      .resolvePageShare({ shareId, ...(requested === undefined ? {} : { pageId: requested }) })
      .pipe(Effect.catch((error) => Effect.flatMap(accessFailure(inactive)(error), Effect.fail)));
    const now = yield* DateTime.now;
    if (
      !(yield* sharingEnabled) ||
      resolved === null ||
      DateTime.toEpochMillis(now) >= Date.parse(resolved.share.expiresAt) ||
      (yield* connectHostname) !== resolved.share.host
    ) {
      return yield* inactive;
    }
    const { share, pageId, breadcrumb } = resolved;
    if (breadcrumb !== null) return { share, pageId, breadcrumb };
    // A trashed or deleted root ends the link; any other miss is a page outside the tree.
    return yield* resolved.rootLive ? unavailable : inactive;
  });

  const page = Effect.fn("SpacePageShareService.page")(function* (
    token: string,
    requested?: C.SpacePageId,
    cursor?: string,
  ) {
    const { share, pageId, breadcrumb } = yield* authorize(token, requested);
    // Viewers have no client connection, so their events carry no surface and no page details.
    if (cursor === undefined)
      yield* analytics.record("feature.used", { feature: "page_share.view" });
    return yield* spaces
      .readSharedPage({
        rootPageId: share.pageId,
        expiresAt: share.expiresAt,
        pageId,
        breadcrumb,
        ...(cursor === undefined ? {} : { cursor }),
      })
      .pipe(
        Effect.catch((error) => Effect.flatMap(accessFailure(unavailable)(error), Effect.fail)),
      );
  }, bounded);

  const asset = Effect.fn("SpacePageShareService.asset")(function* (
    token: string,
    requested: C.SpacePageId | undefined,
    assetId: C.SpaceAssetId,
  ) {
    const { pageId } = yield* authorize(token, requested);
    return yield* spaces
      .resolveSharedAssetFile({ pageId, assetId })
      .pipe(
        Effect.catch((error) => Effect.flatMap(accessFailure(unavailable)(error), Effect.fail)),
      );
  }, bounded);

  return SpacePageShareService.of({
    create,
    stop,
    get,
    page,
    asset,
  });
});

export const layer = Layer.effect(SpacePageShareService, make);
