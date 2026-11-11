import {
  SpacePageGetResult,
  SpacePageLocation,
  type SpacePageId,
  type SpacePageSummary,
} from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

const encodePage = Schema.encodeSync(Schema.fromJsonString(SpacePageGetResult));
const sameLocation = Schema.toEquivalence(Schema.NullOr(SpacePageLocation));

const SPACE_LOCATION_LIMITS = { maxPages: 16, maxBytes: 2 * 1024 * 1024 } as const;
/** @public Required to name the location query's inferred error type. */
export class SpaceLocationError extends Schema.TaggedError<SpaceLocationError>()(
  "SpaceLocationError",
  { message: Schema.String },
) {}

export const readSpacePageLocation = Effect.fn("Spaces.readPageLocation")(function* <
  E,
  R,
  E2 = never,
  R2 = never,
>(
  input: { pageId: SpacePageId; version: 1 | 2 },
  read: (pageId: SpacePageId) => Effect.Effect<SpacePageGetResult, E, R>,
  /** A database row has no location of its own; its host page is where the database lives. */
  readRowHost?: (
    page: SpacePageSummary,
  ) => Effect.Effect<{ readonly hostPageId: SpacePageId }, E2, R2>,
) {
  const current = yield* read(input.pageId);
  const ancestors: SpacePageSummary[] = [];
  const seen = new Set<SpacePageId>();
  let result = current;
  let expectedId = input.pageId;
  let bytes = 0;
  let rowHost: SpacePageId | undefined;
  let rowSource: SpacePageSummary["row"];
  if (input.version === 2 && readRowHost && current.page.row && !current.page.location) {
    rowSource = current.page.row;
    rowHost = (yield* readRowHost(current.page)).hostPageId;
  }
  let first = true;
  while (true) {
    const page = result.page;
    bytes += new TextEncoder().encode(encodePage(result)).byteLength;
    if (
      page.id !== expectedId ||
      page.spaceId !== current.space.id ||
      result.space.id !== current.space.id ||
      seen.has(page.id)
    ) {
      return yield* new SpaceLocationError({
        message: "The page location changed. Refresh to resolve it.",
      });
    }
    seen.add(page.id);
    if (bytes > SPACE_LOCATION_LIMITS.maxBytes)
      return yield* new SpaceLocationError({
        message: "The page location exceeds the navigation limit.",
      });
    if (first && rowHost !== undefined) {
      first = false;
      if (seen.has(rowHost))
        return yield* new SpaceLocationError({
          message: "The page ancestry exceeds the navigation limit or contains a cycle.",
        });
      expectedId = rowHost;
      result = yield* read(rowHost);
      ancestors.unshift(result.page);
      continue;
    }
    first = false;
    if (input.version === 1) {
      if (page.rootOrder === null || page.location?.kind === "child")
        return yield* new SpaceLocationError({
          message: "Update this environment to navigate nested pages.",
        });
      break;
    }
    const location = page.location;
    if (!location || location.spaceId !== page.spaceId)
      return yield* new SpaceLocationError({
        message: "Current page location is unavailable. Refresh to resolve it.",
      });
    if (location.kind === "root") break;
    if (seen.size >= SPACE_LOCATION_LIMITS.maxPages || seen.has(location.parentPageId))
      return yield* new SpaceLocationError({
        message: "The page ancestry exceeds the navigation limit or contains a cycle.",
      });
    expectedId = location.parentPageId;
    result = yield* read(expectedId);
    ancestors.unshift(result.page);
  }
  if (input.version === 2 && ancestors.length > 0) {
    for (const page of [current.page, ...ancestors]) {
      const verified = yield* read(page.id);
      bytes += new TextEncoder().encode(encodePage(verified)).byteLength;
      if (bytes > SPACE_LOCATION_LIMITS.maxBytes)
        return yield* new SpaceLocationError({
          message: "The page location exceeds the navigation limit.",
        });
      if (
        verified.page.id !== page.id ||
        verified.page.revision !== page.revision ||
        verified.page.spaceId !== page.spaceId ||
        verified.space.id !== page.spaceId ||
        !sameLocation(verified.page.location ?? null, page.location ?? null)
      )
        return yield* new SpaceLocationError({
          message: "The page location changed. Refresh to resolve it.",
        });
    }
  }
  return {
    ...current,
    ancestors,
    ...(rowHost === undefined || rowSource === undefined
      ? {}
      : { row: { dataSourceId: rowSource.dataSourceId, hostPageId: rowHost } }),
  };
});
