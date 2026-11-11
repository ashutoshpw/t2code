import type { SpaceDatabaseRow, SpaceGroupKey } from "@t2code/contracts/spaces";

import { GROUP_HEIGHT, type GridItem } from "../table/gridItems";

export type CardSize = "small" | "medium" | "large";

export const CARD_GAP = 12;
export const CARD_PADDING = 8;
const TITLE_HEIGHT = 36;
const PROPERTY_LINE_HEIGHT = 24;
export const AUX_HEIGHT = 32;

const MIN_WIDTH: Record<CardSize, number> = { small: 180, medium: 260, large: 320 };
const COVER_HEIGHT: Record<CardSize, number> = { small: 100, medium: 160, large: 200 };

export const columnsFor = (width: number, size: CardSize) =>
  Math.max(1, Math.floor((width + CARD_GAP) / (MIN_WIDTH[size] + CARD_GAP)));

export const coverHeight = (size: CardSize, hasCover: boolean) =>
  hasCover ? COVER_HEIGHT[size] : 0;

/** One height for every card of a view: empty property lines keep theirs. */
export const cardHeight = (size: CardSize, hasCover: boolean, lines: number) =>
  coverHeight(size, hasCover) + TITLE_HEIGHT + PROPERTY_LINE_HEIGHT * lines;

export type GalleryCell =
  | { readonly kind: "row"; readonly row: SpaceDatabaseRow; readonly group: SpaceGroupKey | null }
  | { readonly kind: "add"; readonly group: SpaceGroupKey | null }
  | { readonly kind: "skeleton" };

export type GalleryItem =
  | { readonly kind: "cards"; readonly cells: ReadonlyArray<GalleryCell> }
  | Extract<GridItem, { kind: "group" | "more" }>;

export interface GalleryLayout {
  readonly items: ReadonlyArray<GalleryItem>;
  /** `offsets[i]` is the top of item `i`. */
  readonly offsets: ReadonlyArray<number>;
  readonly total: number;
  readonly columns: number;
}

/** Packs the table's flat items into card rows; headers and `Load more` stay full width. */
export function buildGalleryLayout(input: {
  readonly items: ReadonlyArray<GridItem>;
  readonly columns: number;
  readonly cardHeight: number;
}): GalleryLayout {
  const items: GalleryItem[] = [];
  let cells: GalleryCell[] = [];
  let more: Extract<GridItem, { kind: "more" }> | null = null;
  const flush = () => {
    for (let at = 0; at < cells.length; at += input.columns)
      items.push({ kind: "cards", cells: cells.slice(at, at + input.columns) });
    cells = [];
    if (more !== null) items.push(more);
    more = null;
  };
  for (const item of input.items) {
    if (item.kind === "group") {
      flush();
      items.push(item);
    } else if (item.kind === "more") more = item;
    else if (item.kind === "row" || item.kind === "add" || item.kind === "skeleton")
      cells.push(item);
  }
  flush();
  const offsets: number[] = [];
  let total = 0;
  for (const item of items) {
    offsets.push(total);
    total +=
      item.kind === "cards"
        ? input.cardHeight + CARD_GAP
        : item.kind === "group"
          ? GROUP_HEIGHT
          : AUX_HEIGHT;
  }
  return { items, offsets, total, columns: input.columns };
}
