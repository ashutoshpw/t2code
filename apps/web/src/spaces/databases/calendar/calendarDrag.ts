import { dayNumber, resizeDateValue, shiftDateValue } from "@t2code/client-runtime/spaces";
import type { SpaceDateValue, SpacePageId } from "@t2code/contracts/spaces";

export type DragEdge = "move" | "start" | "end";

/** Whole days from `from` to `to`. */
export const dayDelta = (from: string, to: string): number =>
  (dayNumber(to) ?? 0) - (dayNumber(from) ?? 0);

/**
 * The value after dropping an item on `dropDay`. `grabDay` is the day of the item the pointer
 * held, so grabbing the third day of a span and dropping on Friday puts that day on Friday.
 * Null when nothing would change.
 */
export function dropValue(
  value: unknown,
  edge: DragEdge,
  grabDay: string,
  dropDay: string,
  timeZone: string,
): SpaceDateValue | null {
  const delta = dayDelta(grabDay, dropDay);
  if (delta === 0) return null;
  return edge === "move"
    ? shiftDateValue(value, delta, timeZone)
    : resizeDateValue(value, edge, delta, timeZone);
}

/** What an item or an edge handle carries through dnd-kit. */
export interface DragData {
  readonly pageId: SpacePageId;
  readonly edge: DragEdge;
  /** First visible day of the grabbed segment. */
  readonly segmentStart: string;
  readonly itemStart: string;
  readonly itemEnd: string;
}

export const DAY_ID_PREFIX = "day:";

/** The day cell under a point, for the day of a multi-day item the pointer actually held. */
export function dayAtPoint(x: number, y: number): string | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const day = element instanceof HTMLElement ? element.dataset.day : undefined;
    if (day !== undefined) return day;
  }
  return null;
}
