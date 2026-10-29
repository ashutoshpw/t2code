import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SpaceBlockWindow, SpacePageId } from "./spaces.ts";

/**
 * A page share lets anyone holding the link read one Spaces page and its sub-pages over T2
 * Connect. The Spaces database holds the public state; the link's credential is derived from
 * the share id with a server key and never stored.
 */
export const SPACE_PAGE_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SPACE_PAGE_SHARE_ROUTE_PREFIX = "/api/shared-page";
/** The viewer page; the link carries the credential after `#` so servers never log it. */
export const SPACE_PAGE_SHARE_PAGE_PATH = "/shared-page";
/** The routes and viewer name the share's credential and the page they mean with these parameters. */
export const SPACE_PAGE_SHARE_PARAM = "share";
export const SPACE_PAGE_SHARE_PAGE_PARAM = "page";
export const SPACE_PAGE_SHARE_ASSET_PARAM = "id";
/** The page title, edited time, blocks, breadcrumb and sub-pages: `?share=<credential>&page=<id>`. */
export const SPACE_PAGE_SHARE_PAGE_ROUTE = `${SPACE_PAGE_SHARE_ROUTE_PREFIX}/page`;
/** An image, PDF or video shown on the page: `?share=<credential>&page=<id>&id=<asset id>`. */
export const SPACE_PAGE_SHARE_ASSET_ROUTE = `${SPACE_PAGE_SHARE_ROUTE_PREFIX}/asset`;

export const SpacePageShareId = TrimmedNonEmptyString.pipe(Schema.brand("SpacePageShareId"));
export type SpacePageShareId = typeof SpacePageShareId.Type;

export const SpacePageShare = Schema.Struct({
  id: SpacePageShareId,
  pageId: SpacePageId,
  /** The T2 Connect tunnel hostname the link points at. Shared routes require it to still serve. */
  host: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type SpacePageShare = typeof SpacePageShare.Type;

export const SpacePageShareLink = Schema.Struct({
  url: TrimmedNonEmptyString,
  share: SpacePageShare,
});
export type SpacePageShareLink = typeof SpacePageShareLink.Type;

export const SpacePageShareCreateInput = Schema.Struct({ pageId: SpacePageId });
export type SpacePageShareCreateInput = typeof SpacePageShareCreateInput.Type;
export const SpacePageShareCreateResult = SpacePageShareLink;
export type SpacePageShareCreateResult = typeof SpacePageShareCreateResult.Type;

export const SpacePageShareStopInput = Schema.Struct({ pageId: SpacePageId });
export type SpacePageShareStopInput = typeof SpacePageShareStopInput.Type;
export const SpacePageShareStopResult = Schema.Struct({});
export type SpacePageShareStopResult = typeof SpacePageShareStopResult.Type;

export const SpacePageShareGetInput = Schema.Struct({ pageId: SpacePageId });
export type SpacePageShareGetInput = typeof SpacePageShareGetInput.Type;
/** The page's current link, or null once it was stopped. An expired link is still returned. */
export const SpacePageShareGetResult = Schema.Struct({
  link: Schema.NullOr(SpacePageShareLink),
});
export type SpacePageShareGetResult = typeof SpacePageShareGetResult.Type;

const SPACE_PAGE_SHARE_MESSAGES = {
  disabled: "Page sharing is off. Turn it on in Settings > Labs.",
  connect_unavailable: "Page sharing needs a running T2 Connect tunnel.",
  page_unavailable: "This page cannot be shared.",
  failed: "Failed to update the page share.",
} as const;

export class SpacePageShareError extends Schema.TaggedError<SpacePageShareError>()(
  "SpacePageShareError",
  {
    reason: Schema.Literals(["disabled", "connect_unavailable", "page_unavailable", "failed"]),
  },
) {
  override get message(): string {
    return SPACE_PAGE_SHARE_MESSAGES[this.reason];
  }
}

export const SpaceSharedPageRef = Schema.Struct({ id: SpacePageId, title: Schema.String });
export type SpaceSharedPageRef = typeof SpaceSharedPageRef.Type;

/** What the page route returns. Every page and asset it names is inside the shared tree. */
export const SpaceSharedPage = Schema.Struct({
  rootPageId: SpacePageId,
  expiresAt: IsoDateTime,
  page: Schema.Struct({ id: SpacePageId, title: Schema.String, updatedAt: IsoDateTime }),
  window: SpaceBlockWindow,
  /** From the shared root down to this page, both included. */
  breadcrumb: Schema.Array(SpaceSharedPageRef),
  /** Sub-pages in page order, without trashed ones. */
  children: Schema.Array(
    Schema.Struct({ id: SpacePageId, title: Schema.String, updatedAt: IsoDateTime }),
  ),
});
export type SpaceSharedPage = typeof SpaceSharedPage.Type;

/** The body of every refused shared-page request, with the status 403 (400 for a bad request). */
export const SpaceSharedPageFailure = Schema.Struct({
  reason: Schema.Literals(["invalid", "inactive", "unavailable"]),
  message: Schema.String,
});
export type SpaceSharedPageFailure = typeof SpaceSharedPageFailure.Type;
