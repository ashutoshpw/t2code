import {
  addDays,
  dayNumber,
  readDateValue,
  rowDaySpan,
  serialTime,
} from "@t2code/client-runtime/spaces";
import type { SpaceDatabaseRow } from "@t2code/contracts/spaces";

const MAX_LANES = 6;

export interface CalendarItem {
  readonly row: SpaceDatabaseRow;
  readonly startDay: string;
  readonly endDay: string;
}

/** One item cut to one week: columns are 0-based days of that week, inclusive. */
export interface WeekSegment {
  readonly item: CalendarItem;
  readonly first: number;
  readonly last: number;
  /** The item started before this week, or goes on after it. */
  readonly continuesBefore: boolean;
  readonly continuesAfter: boolean;
  readonly lane: number;
}

export interface WeekLayout {
  readonly segments: ReadonlyArray<WeekSegment>;
  /** Lanes drawn (at most `MAX_LANES`). */
  readonly lanes: number;
  /** Per day column of the week: items that did not get a lane. */
  readonly overflow: ReadonlyArray<number>;
}

/** Rows to items. A row whose cell holds no date is left out. */
export function calendarItems(
  rows: ReadonlyArray<SpaceDatabaseRow>,
  propertyId: string,
  timeZone: string,
): ReadonlyArray<CalendarItem> {
  const items: CalendarItem[] = [];
  for (const row of rows) {
    const span = rowDaySpan(row.cells[propertyId], timeZone);
    if (span !== null) items.push({ row, ...span });
  }
  return items;
}

/**
 * Cuts items to one week, orders them (longer first, then earlier start, then query order) and
 * gives each the lowest lane free over its columns. Items past `MAX_LANES` count as overflow on
 * every day they cover.
 */
export function layoutWeek(
  items: ReadonlyArray<CalendarItem>,
  weekFirstDay: string,
  maxLanes = MAX_LANES,
): WeekLayout {
  const weekStart = dayNumber(weekFirstDay) ?? 0;
  const lastDay = addDays(weekFirstDay, 6);
  const cut: Array<{
    item: CalendarItem;
    first: number;
    last: number;
    order: number;
    length: number;
  }> = [];
  items.forEach((item, order) => {
    if (item.endDay < weekFirstDay || item.startDay > lastDay) return;
    const first = Math.max(0, (dayNumber(item.startDay) ?? 0) - weekStart);
    const last = Math.min(6, (dayNumber(item.endDay) ?? 0) - weekStart);
    cut.push({
      item,
      first,
      last,
      order,
      length: (dayNumber(item.endDay) ?? 0) - (dayNumber(item.startDay) ?? 0),
    });
  });
  cut.sort(
    (a, b) =>
      b.length - a.length ||
      (a.item.startDay < b.item.startDay ? -1 : a.item.startDay > b.item.startDay ? 1 : 0) ||
      a.order - b.order,
  );
  const taken: boolean[][] = [];
  const segments: WeekSegment[] = [];
  const overflow = new Array<number>(7).fill(0);
  for (const entry of cut) {
    let lane = 0;
    for (; ; lane++) {
      const row = (taken[lane] ??= new Array<boolean>(7).fill(false));
      let free = true;
      for (let day = entry.first; day <= entry.last; day++) if (row[day]) free = false;
      if (free) break;
    }
    if (lane >= maxLanes) {
      for (let day = entry.first; day <= entry.last; day++) overflow[day]!++;
      continue;
    }
    for (let day = entry.first; day <= entry.last; day++) taken[lane]![day] = true;
    segments.push({
      item: entry.item,
      first: entry.first,
      last: entry.last,
      continuesBefore: entry.item.startDay < weekFirstDay,
      continuesAfter: entry.item.endDay > lastDay,
      lane,
    });
  }
  return {
    segments,
    lanes: Math.min(maxLanes, taken.length),
    overflow,
  };
}

/** Every item on one day, in the order of `calendarItems`. */
export const itemsOnDay = (items: ReadonlyArray<CalendarItem>, day: string) =>
  items.filter((item) => item.startDay <= day && item.endDay >= day);

/** The grid columns (0 = first day of the week) that are drawn; weekends can be hidden. */
export function visibleOffsets(weekFirstDay: string, showWeekends: boolean): ReadonlyArray<number> {
  const offsets: number[] = [];
  for (let offset = 0; offset < 7; offset++) {
    const weekday = ((dayNumber(addDays(weekFirstDay, offset)) ?? 0) + 4) % 7;
    if (showWeekends || (weekday !== 0 && weekday !== 6)) offsets.push(offset);
  }
  return offsets;
}

/**
 * 1-based grid column span of a segment over the drawn columns, or null when every day it covers
 * is hidden. A span that starts on a hidden day begins at the next drawn one.
 */
export function gridSpan(
  first: number,
  last: number,
  offsets: ReadonlyArray<number>,
): { readonly start: number; readonly end: number } | null {
  const inside = offsets.flatMap((offset, index) =>
    offset >= first && offset <= last ? [index] : [],
  );
  if (inside.length === 0) return null;
  return { start: inside[0]! + 1, end: inside[inside.length - 1]! + 2 };
}

/** The start time of a timed item that sits on one day, as `HH:mm`; null otherwise. */
export function itemTime(item: CalendarItem, propertyId: string, timeZone: string): string | null {
  if (item.startDay !== item.endDay) return null;
  const read = readDateValue(item.row.cells[propertyId], timeZone);
  return read?.start.timed === true ? serialTime(read.start.serial) : null;
}
