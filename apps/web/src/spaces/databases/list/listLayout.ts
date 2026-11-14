import { GROUP_HEIGHT, type GridItem } from "../table/gridItems";

export const LIST_ROW_HEIGHT = 32;

export interface ListLayout {
  readonly items: ReadonlyArray<GridItem>;
  /** `offsets[i]` is the top of item `i`. */
  readonly offsets: ReadonlyArray<number>;
  readonly total: number;
}

export function buildListLayout(items: ReadonlyArray<GridItem>): ListLayout {
  const offsets: number[] = [];
  let total = 0;
  for (const item of items) {
    offsets.push(total);
    total += item.kind === "group" ? GROUP_HEIGHT : LIST_ROW_HEIGHT;
  }
  return { items, offsets, total };
}

/** The row a move swaps with: up moves the row before its predecessor, down moves the successor before it. */
export function moveTarget(
  items: ReadonlyArray<GridItem>,
  pageId: string,
  direction: "up" | "down",
): { readonly moving: string; readonly before: string } | null {
  const index = items.findIndex((item) => item.kind === "row" && item.row.page.id === pageId);
  if (index < 0) return null;
  const other = items[direction === "up" ? index - 1 : index + 1];
  if (other?.kind !== "row") return null;
  return direction === "up"
    ? { moving: pageId, before: other.row.page.id }
    : { moving: other.row.page.id, before: pageId };
}
