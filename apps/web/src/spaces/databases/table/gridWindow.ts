import { ROW_HEIGHT } from "./gridItems";

export interface Range {
  /** Inclusive. */
  readonly first: number;
  /** Exclusive. */
  readonly last: number;
}

export const HEADER_HEIGHT = ROW_HEIGHT;
export const FOOTER_HEIGHT = ROW_HEIGHT;
export const DEFAULT_COLUMN_WIDTH = 200;
export const TITLE_COLUMN_WIDTH = 280;
export const MIN_COLUMN_WIDTH = 80;
export const MAX_COLUMN_WIDTH = 800;

export const clampWidth = (width: number) =>
  Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));

/** Index of the last item whose top is at or above `y`; 0 when there are no items. */
export function itemAt(offsets: ReadonlyArray<number>, y: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid]! <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Items to mount: the ones in view plus `overscan` on each side. */
export function rowRange(
  offsets: ReadonlyArray<number>,
  total: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 6,
): Range {
  const count = offsets.length;
  if (count === 0 || total <= 0) return { first: 0, last: 0 };
  const top = Math.max(0, scrollTop);
  const first = itemAt(offsets, top);
  const last = itemAt(offsets, Math.min(total - 1, top + Math.max(0, viewportHeight)));
  return { first: Math.max(0, first - overscan), last: Math.min(count, last + 1 + overscan) };
}

/** Columns after the frozen title column that intersect the viewport, plus `overscan` each side. */
export function columnRange(
  widths: ReadonlyArray<number>,
  frozenWidth: number,
  scrollLeft: number,
  viewportWidth: number,
  overscan = 1,
): Range {
  const count = widths.length;
  if (count === 0) return { first: 0, last: 0 };
  const visibleEnd = scrollLeft + Math.max(0, viewportWidth - frozenWidth);
  let first = count;
  let last = 0;
  let left = 0;
  for (let index = 0; index < count; index += 1) {
    const right = left + widths[index]!;
    if (right > scrollLeft && left < visibleEnd) {
      if (first === count) first = index;
      last = index + 1;
    }
    left = right;
  }
  if (first === count) return { first: 0, last: Math.min(count, 1 + overscan) };
  return { first: Math.max(0, first - overscan), last: Math.min(count, last + overscan) };
}

export const sameRange = (a: Range, b: Range) => a.first === b.first && a.last === b.last;

/** Scroll offsets that bring a cell into the open area between the sticky header, footer and title column. */
export function scrollToCell(input: {
  readonly itemTop: number;
  readonly itemHeight: number;
  readonly columnLeft: number | null;
  readonly columnWidth: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
  readonly frozenWidth: number;
  readonly footerHeight: number;
}): { top: number; left: number } {
  const open = Math.max(ROW_HEIGHT, input.viewportHeight - HEADER_HEIGHT - input.footerHeight);
  let top = input.scrollTop;
  if (input.itemTop < top) top = input.itemTop;
  else if (input.itemTop + input.itemHeight > top + open)
    top = input.itemTop + input.itemHeight - open;
  let left = input.scrollLeft;
  if (input.columnLeft !== null) {
    if (input.columnLeft < left) left = input.columnLeft;
    else if (input.columnLeft + input.columnWidth > left + input.viewportWidth - input.frozenWidth)
      left = input.columnLeft + input.columnWidth - (input.viewportWidth - input.frozenWidth);
  }
  return { top: Math.max(0, top), left: Math.max(0, left) };
}
