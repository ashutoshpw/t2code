import {
  SPACE_PAGE_SHARE_ASSET_PARAM,
  SPACE_PAGE_SHARE_BLOCK_PARAM,
  SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE,
  SPACE_PAGE_SHARE_DATABASE_ROUTE,
  SPACE_PAGE_SHARE_DATABASE_ROW_ROUTE,
  SPACE_PAGE_SHARE_FROM_PARAM,
  SPACE_PAGE_SHARE_GROUP_PARAM,
  SPACE_PAGE_SHARE_ROW_PARAM,
  SPACE_PAGE_SHARE_TO_PARAM,
  SPACE_PAGE_SHARE_VIEW_PARAM,
  SPACE_PAGE_SHARE_ZONE_PARAM,
  SpaceSharedDatabase,
  SpaceSharedDatabaseRowPage,
  SpaceSharedDatabaseWindow,
  SPACE_FORM_SUBMISSION_MAX_BYTES,
  SPACE_PAGE_SHARE_FORM_ROUTE,
  SpaceSharedForm,
  SpaceSharedFormSubmission,
  SPACE_PAGE_SHARE_ASSET_ROUTE,
  SPACE_PAGE_SHARE_CURSOR_PARAM,
  SPACE_PAGE_SHARE_HEADER,
  SPACE_PAGE_SHARE_PAGE_PARAM,
  SPACE_PAGE_SHARE_PAGE_ROUTE,
  SPACE_PAGE_SHARE_PARAM,
  SpaceSharedPage,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ByteSize from "effect/ByteSize";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { assetFileResponse } from "../http.ts";
import {
  SharedDatabaseRequestError,
  SharedFormRejectedError,
  SpacePageShareAccessError,
  SpacePageShareService,
} from "./PageShareService.ts";

const NO_STORE = { "cache-control": "no-store" };
const MAX_PARAM_LENGTH = 512;
const MAX_QUERY_CURSOR_LENGTH = 8_192;

const encodePage = Schema.encodeEffect(SpaceSharedPage);

const STATUS = {
  invalid: 403,
  inactive: 403,
  unavailable: 403,
  busy: 429,
  failed: 503,
  closed: 403,
} as const;

const errorResponse = (error: SpacePageShareAccessError) =>
  HttpServerResponse.json(
    { reason: error.reason, message: error.message },
    {
      status: STATUS[error.reason],
      headers: error.reason === "busy" ? { ...NO_STORE, "retry-after": "2" } : NO_STORE,
    },
  );

const badRequest = HttpServerResponse.json(
  { reason: "invalid", message: "The request was not valid." },
  { status: 400, headers: NO_STORE },
);

const describe = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "unknown";

const parameters = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => new URLSearchParams(request.url.split("?", 2)[1] ?? ""),
);

const within = (value: string | null, max = MAX_PARAM_LENGTH) =>
  value !== null && value.length > 0 && value.length <= max ? value : null;

// The credential is the only authority: every request is checked again, so a stopped, replaced
// or expired link stops at once. Routes only read, and only inside the shared tree.
const pageRoute = HttpRouter.add(
  "GET",
  SPACE_PAGE_SHARE_PAGE_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = yield* parameters;
    const token = within(request.headers[SPACE_PAGE_SHARE_HEADER] ?? null);
    const requested = query.get(SPACE_PAGE_SHARE_PAGE_PARAM);
    const cursor = query.get(SPACE_PAGE_SHARE_CURSOR_PARAM);
    if (
      token === null ||
      (requested !== null && within(requested) === null) ||
      (cursor !== null && within(cursor) === null)
    )
      return yield* badRequest;
    const shares = yield* SpacePageShareService;
    return yield* shares
      .page(
        token,
        requested === null ? undefined : C.SpacePageId.make(requested),
        cursor === null ? undefined : cursor,
      )
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
    const block = query.get(SPACE_PAGE_SHARE_BLOCK_PARAM);
    const view = query.get(SPACE_PAGE_SHARE_VIEW_PARAM);
    const rowId = query.get(SPACE_PAGE_SHARE_ROW_PARAM);
    // The row form names a database row by all three, or none of them.
    const formed = [block, view, rowId].filter((value) => value !== null).length;
    const inRow =
      formed === 3 && within(block) !== null && within(view) !== null && within(rowId) !== null;
    if (
      token === null ||
      assetId === null ||
      (requested !== null && within(requested) === null) ||
      (formed !== 0 && !inRow)
    ) {
      return yield* badRequest;
    }
    const shares = yield* SpacePageShareService;
    return yield* shares
      .asset(
        token,
        requested === null ? undefined : C.SpacePageId.make(requested),
        C.SpaceAssetId.make(assetId),
        inRow
          ? {
              blockId: C.SpaceBlockId.make(block!),
              viewId: C.SpaceViewId.make(view!),
              rowId: C.SpacePageId.make(rowId!),
            }
          : undefined,
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
        Effect.catch((error) =>
          Effect.logError("Shared page asset response failed", { error: describe(error) }).pipe(
            Effect.as(HttpServerResponse.empty({ status: 500, headers: NO_STORE })),
          ),
        ),
      );
  }),
);

const encodeDatabase = Schema.encodeEffect(SpaceSharedDatabase);
const encodeWindow = Schema.encodeEffect(SpaceSharedDatabaseWindow);
const encodeRow = Schema.encodeEffect(SpaceSharedDatabaseRowPage);

/** An optional parameter: absent is fine, present must be non-empty and within `max`. */
const optionalParam = (query: URLSearchParams, name: string, max = MAX_PARAM_LENGTH) => {
  const value = query.get(name);
  return value === null
    ? { ok: true, value: undefined }
    : { ok: within(value, max) !== null, value };
};

const answer = <A, I, E>(
  result: Effect.Effect<A, SpacePageShareAccessError | SharedDatabaseRequestError>,
  encode: (value: A) => Effect.Effect<I, E>,
) =>
  result.pipe(
    Effect.flatMap((value) =>
      encode(value).pipe(
        Effect.mapError(() => new SpacePageShareAccessError({ reason: "unavailable" })),
      ),
    ),
    Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { headers: NO_STORE })),
    Effect.catchTags({
      SpacePageShareAccessError: errorResponse,
      SharedDatabaseRequestError: () => badRequest,
    }),
  );

// The JSON database routes take the credential only in the header, as the page route does.
const databaseRoute = HttpRouter.add(
  "GET",
  SPACE_PAGE_SHARE_DATABASE_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = yield* parameters;
    const token = within(request.headers[SPACE_PAGE_SHARE_HEADER] ?? null);
    const block = within(query.get(SPACE_PAGE_SHARE_BLOCK_PARAM));
    const page = optionalParam(query, SPACE_PAGE_SHARE_PAGE_PARAM);
    if (token === null || block === null || !page.ok) return yield* badRequest;
    const shares = yield* SpacePageShareService;
    return yield* answer(
      shares.database(
        token,
        page.value === undefined ? undefined : C.SpacePageId.make(page.value),
        C.SpaceBlockId.make(block),
      ),
      encodeDatabase,
    );
  }),
);

const queryRoute = HttpRouter.add(
  "GET",
  SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = yield* parameters;
    const token = within(request.headers[SPACE_PAGE_SHARE_HEADER] ?? null);
    const block = within(query.get(SPACE_PAGE_SHARE_BLOCK_PARAM));
    const view = within(query.get(SPACE_PAGE_SHARE_VIEW_PARAM));
    const page = optionalParam(query, SPACE_PAGE_SHARE_PAGE_PARAM);
    const group = optionalParam(query, SPACE_PAGE_SHARE_GROUP_PARAM);
    const from = optionalParam(query, SPACE_PAGE_SHARE_FROM_PARAM);
    const to = optionalParam(query, SPACE_PAGE_SHARE_TO_PARAM);
    const cursor = optionalParam(query, SPACE_PAGE_SHARE_CURSOR_PARAM, MAX_QUERY_CURSOR_LENGTH);
    const zone = optionalParam(query, SPACE_PAGE_SHARE_ZONE_PARAM);
    if (
      token === null ||
      block === null ||
      view === null ||
      !(page.ok && group.ok && from.ok && to.ok && cursor.ok && zone.ok)
    )
      return yield* badRequest;
    const shares = yield* SpacePageShareService;
    return yield* answer(
      shares.databaseQuery(token, {
        ...(page.value === undefined ? {} : { pageId: C.SpacePageId.make(page.value) }),
        blockId: C.SpaceBlockId.make(block),
        viewId: C.SpaceViewId.make(view),
        ...(group.value === undefined ? {} : { group: group.value }),
        ...(from.value === undefined ? {} : { from: from.value }),
        ...(to.value === undefined ? {} : { to: to.value }),
        ...(cursor.value === undefined ? {} : { cursor: cursor.value }),
        ...(zone.value === undefined ? {} : { timeZone: zone.value }),
      }),
      encodeWindow,
    );
  }),
);

const rowRoute = HttpRouter.add(
  "GET",
  SPACE_PAGE_SHARE_DATABASE_ROW_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = yield* parameters;
    const token = within(request.headers[SPACE_PAGE_SHARE_HEADER] ?? null);
    const block = within(query.get(SPACE_PAGE_SHARE_BLOCK_PARAM));
    const view = within(query.get(SPACE_PAGE_SHARE_VIEW_PARAM));
    const row = within(query.get(SPACE_PAGE_SHARE_ROW_PARAM));
    const page = optionalParam(query, SPACE_PAGE_SHARE_PAGE_PARAM);
    const cursor = optionalParam(query, SPACE_PAGE_SHARE_CURSOR_PARAM);
    const zone = optionalParam(query, SPACE_PAGE_SHARE_ZONE_PARAM);
    if (
      token === null ||
      block === null ||
      view === null ||
      row === null ||
      !(page.ok && cursor.ok && zone.ok)
    )
      return yield* badRequest;
    const shares = yield* SpacePageShareService;
    return yield* answer(
      shares.databaseRow(token, {
        ...(page.value === undefined ? {} : { pageId: C.SpacePageId.make(page.value) }),
        blockId: C.SpaceBlockId.make(block),
        viewId: C.SpaceViewId.make(view),
        rowId: C.SpacePageId.make(row),
        ...(cursor.value === undefined ? {} : { cursor: cursor.value }),
        ...(zone.value === undefined ? {} : { timeZone: zone.value }),
      }),
      encodeRow,
    );
  }),
);

const encodeForm = Schema.encodeEffect(SpaceSharedForm);
const decodeSubmission = Schema.decodeUnknownEffect(SpaceSharedFormSubmission, {
  onExcessProperty: "error",
});

const formRoute = HttpRouter.add(
  "GET",
  SPACE_PAGE_SHARE_FORM_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = yield* parameters;
    const token = within(request.headers[SPACE_PAGE_SHARE_HEADER] ?? null);
    const block = within(query.get(SPACE_PAGE_SHARE_BLOCK_PARAM));
    const view = within(query.get(SPACE_PAGE_SHARE_VIEW_PARAM));
    const page = optionalParam(query, SPACE_PAGE_SHARE_PAGE_PARAM);
    if (token === null || block === null || view === null || !page.ok) return yield* badRequest;
    const shares = yield* SpacePageShareService;
    return yield* answer(
      shares.form(token, {
        ...(page.value === undefined ? {} : { pageId: C.SpacePageId.make(page.value) }),
        blockId: C.SpaceBlockId.make(block),
        viewId: C.SpaceViewId.make(view),
      }),
      encodeForm,
    );
  }),
);

const tooLarge = HttpServerResponse.json(
  { reason: "invalid", message: "The request was too large." },
  { status: 413, headers: NO_STORE },
);

// A body over the cap is refused by its declared length before reading; a chunked body hits the reader cap.
const readSubmission = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"] ?? "0") > SPACE_FORM_SUBMISSION_MAX_BYTES)
    return yield* Effect.fail("too_large" as const);
  const json = yield* request.json.pipe(
    Effect.provideService(
      HttpIncomingMessage.MaxBodySize,
      ByteSize.bytes(SPACE_FORM_SUBMISSION_MAX_BYTES),
    ),
    Effect.mapError(({ reason }) =>
      "reason" in reason && reason.reason === "BodyTooLarge"
        ? ("too_large" as const)
        : ("bad" as const),
    ),
  );
  return yield* decodeSubmission(json).pipe(Effect.mapError(() => "bad" as const));
});

// The credential comes from the header only, so it never reaches a URL log.
const formSubmitRoute = HttpRouter.add(
  "POST",
  SPACE_PAGE_SHARE_FORM_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = yield* parameters;
    const token = within(request.headers[SPACE_PAGE_SHARE_HEADER] ?? null);
    if (token === null || query.has(SPACE_PAGE_SHARE_PARAM)) return yield* badRequest;
    const body = yield* readSubmission.pipe(Effect.result);
    if (body._tag === "Failure") return yield* body.failure === "too_large" ? tooLarge : badRequest;
    const shares = yield* SpacePageShareService;
    return yield* shares.submitForm(token, body.success).pipe(
      Effect.map(() =>
        HttpServerResponse.jsonUnsafe({ status: "received" }, { headers: NO_STORE }),
      ),
      Effect.catchTags({
        SpacePageShareAccessError: errorResponse,
        SharedFormRejectedError: (error: SharedFormRejectedError) =>
          HttpServerResponse.json(
            {
              reason: "rejected",
              message: "Check your answers and try again.",
              ...(error.propertyId === undefined ? {} : { propertyId: error.propertyId }),
              problem: error.problem,
            },
            { status: 422, headers: NO_STORE },
          ),
      }),
    );
  }),
);

export const layer = Layer.mergeAll(
  pageRoute,
  assetRoute,
  databaseRoute,
  queryRoute,
  rowRoute,
  formRoute,
  formSubmitRoute,
);
