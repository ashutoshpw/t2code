import type {
  SpaceAggregateResult,
  SpaceCardPreview,
  SpaceGroupBucket,
  SpaceGroupKey,
  SpaceKnownDatabaseProperty,
} from "@t2code/contracts/spaces";
import { canonicalJson, formatAggregate } from "@t2code/client-runtime/spaces";

export type BoardCardSize = "small" | "medium" | "large";

const COLUMN_WIDTH: Record<BoardCardSize, number> = { small: 220, medium: 260, large: 320 };
const COVER_HEIGHT: Record<BoardCardSize, number> = { small: 72, medium: 96, large: 128 };
/** A card without a preview: title and a couple of property lines. */
const BASE_CARD_HEIGHT = 72;

export const boardColumnWidth = (size: BoardCardSize | undefined) => COLUMN_WIDTH[size ?? "medium"];
export const boardCoverHeight = (size: BoardCardSize | undefined) => COVER_HEIGHT[size ?? "medium"];

/** The `content-visibility` placeholder size of a card, so the scroll height holds with covers. */
export const boardCardIntrinsicHeight = (size: BoardCardSize | undefined, hasCover: boolean) =>
  BASE_CARD_HEIGHT + (hasCover ? boardCoverHeight(size) : 0);

/** What a board needs from `layout.cardPreview`: a files property, page content, or nothing. */
export function boardPreview(preview: SpaceCardPreview | undefined): {
  readonly propertyId: string | null;
  readonly content: boolean;
} {
  return {
    propertyId: preview?.kind === "property" ? preview.propertyId : null,
    content: preview?.kind === "page_content",
  };
}

/** Up to two compact results of the view's column calculations for a column header. */
export function headerAggregates(
  bucket: Pick<SpaceGroupBucket, "aggregates">,
  properties: ReadonlyMap<string, SpaceKnownDatabaseProperty | null>,
  timeZone: string,
): string {
  const results: ReadonlyArray<SpaceAggregateResult> = bucket.aggregates ?? [];
  return results
    .filter((result) => properties.has(result.property))
    .slice(0, 2)
    .map((result) => formatAggregate(result, properties.get(result.property) ?? null, timeZone))
    .filter((text) => text !== "")
    .join(" · ");
}

/** Stable id of one lane cell: the lane and the column it sits in. */
export const laneCellId = (lane: SpaceGroupKey | undefined, column: SpaceGroupKey) =>
  lane === undefined ? canonicalJson(column) : `${canonicalJson(lane)}|${canonicalJson(column)}`;
