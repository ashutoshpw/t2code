import {
  SpacePageGetResult,
  SpacePageLocation,
  type SpacePageId,
  type SpacePageSummary,
} from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

const encodePage = Schema.encodeSync(Schema.fromJsonString(SpacePageGetResult));
const sameLocation = Schema.toEquivalence(Schema.NullOr(SpacePageLocation));

const SPACE_LOCATION_LIMITS = { maxPages: 16, maxBytes: 2 * 1024 * 1024 } as const;
/** @public Required to name the location query's inferred error type. */
export class SpaceLocationError extends Data.TaggedError("SpaceLocationError")<{
  readonly message: string;
}> {}

export const readSpacePageLocation = Effect.fn("Spaces.readPageLocation")(function* <E, R>(
  input: { pageId: SpacePageId; version: 1 | 2 },
  read: (pageId: SpacePageId) => Effect.Effect<SpacePageGetResult, E, R>,
) {
  const current = yield* read(input.pageId);
  const ancestors: SpacePageSummary[] = [];
  const seen = new Set<SpacePageId>();
  let result = current;
  let expectedId = input.pageId;
  let bytes = 0;
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
  if (input.version === 2) {
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
  return { ...current, ancestors };
});
