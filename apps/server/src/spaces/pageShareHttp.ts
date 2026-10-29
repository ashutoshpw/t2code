import {
  SPACE_PAGE_SHARE_ASSET_PARAM,
  SPACE_PAGE_SHARE_ASSET_ROUTE,
  SPACE_PAGE_SHARE_PAGE_PARAM,
  SPACE_PAGE_SHARE_PAGE_ROUTE,
  SPACE_PAGE_SHARE_PARAM,
  SpaceSharedPage,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { assetFileResponse } from "../http.ts";
import { SpacePageShareAccessError, SpacePageShareService } from "./PageShareService.ts";

const NO_STORE = { "cache-control": "no-store" };
const MAX_PARAM_LENGTH = 512;

const encodePage = Schema.encodeEffect(SpaceSharedPage);

const errorResponse = (error: SpacePageShareAccessError) =>
  HttpServerResponse.json(
    { reason: error.reason, message: error.message },
    { status: 403, headers: NO_STORE },
  );

const badRequest = HttpServerResponse.json(
  { reason: "invalid", message: "The request was not valid." },
  { status: 400, headers: NO_STORE },
);

const parameters = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => new URLSearchParams(request.url.split("?", 2)[1] ?? ""),
);

const within = (value: string | null) =>
  value !== null && value.length > 0 && value.length <= MAX_PARAM_LENGTH ? value : null;

// The credential is the only authority: every request is checked again, so a stopped, replaced
// or expired link stops at once. Routes only read, and only inside the shared tree.
const pageRoute = HttpRouter.add(
  "GET",
  SPACE_PAGE_SHARE_PAGE_ROUTE,
  Effect.gen(function* () {
    const query = yield* parameters;
    const token = within(query.get(SPACE_PAGE_SHARE_PARAM));
    const requested = query.get(SPACE_PAGE_SHARE_PAGE_PARAM);
    if (token === null || (requested !== null && within(requested) === null))
      return yield* badRequest;
    const shares = yield* SpacePageShareService;
    return yield* shares
      .page(token, requested === null ? undefined : C.SpacePageId.make(requested))
      .pipe(
        Effect.flatMap((page) =>
          encodePage(page).pipe(
            Effect.mapError(() => new SpacePageShareAccessError({ reason: "unavailable" })),
          ),
        ),
        Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { headers: NO_STORE })),
        Effect.catchTags({ SpacePageShareAccessError: errorResponse }),
      );
  }),
);

// Media is served the way the guest attachment route serves files: the sandbox policy keeps a
// file from running as a page on this origin.
const assetRoute = HttpRouter.add(
  "GET",
  SPACE_PAGE_SHARE_ASSET_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = yield* parameters;
    const token = within(query.get(SPACE_PAGE_SHARE_PARAM));
    const assetId = within(query.get(SPACE_PAGE_SHARE_ASSET_PARAM));
    const requested = query.get(SPACE_PAGE_SHARE_PAGE_PARAM);
    if (token === null || assetId === null || (requested !== null && within(requested) === null)) {
      return yield* badRequest;
    }
    const shares = yield* SpacePageShareService;
    return yield* shares
      .asset(
        token,
        requested === null ? undefined : C.SpacePageId.make(requested),
        C.SpaceAssetId.make(assetId),
      )
      .pipe(
        Effect.flatMap((asset) =>
          assetFileResponse(
            { path: asset.path, file: asset.file, mimeType: asset.mimeType, fileName: asset.name },
            request.method === "GET" ? request.headers.range : undefined,
            request.headers["if-range"],
          ),
        ),
        Effect.map((response) =>
          HttpServerResponse.setHeaders(response, {
            ...NO_STORE,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          }),
        ),
        Effect.catchTags({ SpacePageShareAccessError: errorResponse }),
        Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500, headers: NO_STORE })),
      );
  }),
);

export const layer = Layer.mergeAll(pageRoute, assetRoute);
