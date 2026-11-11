import { moveDateValue, readDateValue } from "@t2code/client-runtime/spaces";
import type { SpaceCellValue, SpaceDateValue } from "@t2code/contracts/spaces";

const MINUTES_PER_DAY = 1440;
/** A timed value with no end draws one hour long. */
const DEFAULT_TIMED_MINUTES = 60;

export type BarMode = "move" | "start" | "end";

export interface BarSpan {
  /** Wall-clock serials, minutes since 1970-01-01. `end` is exclusive: date-only ends include their day. */
  readonly start: number;
  readonly end: number;
  readonly timed: boolean;
}

/**
 * Where a row's bar sits. `end` comes from the start value's own range, or from the end property
 * when one is configured. Null when there is no start.
 */
export function barSpan(
  startValue: unknown,
  endValue: unknown,
  separateEnd: boolean,
  zone: string,
): BarSpan | null {
  const start = readDateValue(startValue, zone);
  if (start === null) return null;
  const timed = start.start.timed;
  const endRead = separateEnd ? readDateValue(endValue, zone) : start;
  const own = separateEnd ? (endRead?.end ?? endRead?.start ?? null) : start.end;
  const from = start.start.serial;
  const length = timed ? DEFAULT_TIMED_MINUTES : MINUTES_PER_DAY;
  if (own === null || own.serial < from) return { start: from, end: from + length, timed };
  return { start: from, end: own.timed ? own.serial : own.serial + MINUTES_PER_DAY, timed };
}

const withoutEnd = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const { end: _end, ...rest } = value as SpaceDateValue;
  return rest;
};

export interface CellWrite {
  readonly side: "start" | "end";
  readonly value: SpaceCellValue | null;
}

/**
 * The cells a bar drag or key press writes. One property: both edges live in one value, so one
 * write. Two properties: the start cell and the end cell each move as a single date. Empty
 * results are dropped.
 */
export function barWrites(input: {
  readonly mode: BarMode;
  readonly deltaMinutes: number;
  readonly startValue: unknown;
  readonly endValue: unknown;
  readonly separateEnd: boolean;
  readonly zone: string;
}): ReadonlyArray<CellWrite> {
  const { mode, deltaMinutes: d, startValue, endValue, separateEnd, zone } = input;
  if (d === 0) return [];
  const moveStart = mode !== "end";
  const moveEnd = mode !== "start";
  if (!separateEnd) {
    const value: SpaceDateValue | null = moveDateValue(
      startValue,
      { startMinutes: moveStart ? d : 0, endMinutes: moveEnd ? d : 0 },
      zone,
    );
    return value === null ? [] : [{ side: "start", value }];
  }
  // The start never passes the end, and the end never precedes the start.
  const from = readDateValue(startValue, zone)?.start.serial;
  const to = readDateValue(endValue, zone)?.start.serial;
  const bound =
    from === undefined || to === undefined
      ? d
      : mode === "start"
        ? Math.min(d, to - from)
        : mode === "end"
          ? Math.max(d, from - to)
          : d;
  if (bound === 0 && mode !== "move") return [];
  const writes: CellWrite[] = [];
  if (moveStart) {
    const value = moveDateValue(startValue, { startMinutes: bound, endMinutes: bound }, zone);
    if (value !== null) writes.push({ side: "start", value });
  }
  if (moveEnd && readDateValue(endValue, zone) !== null) {
    const value = moveDateValue(endValue, { startMinutes: bound, endMinutes: bound }, zone);
    if (value !== null) writes.push({ side: "end", value });
  } else if (mode === "end") {
    // Resizing a bar whose end property is empty: the end starts at the start day.
    const value = moveDateValue(withoutEnd(startValue), { startMinutes: d, endMinutes: d }, zone);
    if (value !== null) writes.push({ side: "end", value });
  }
  return writes;
}
