import {
  addDays,
  addMonths,
  dayNumber,
  isoDay,
  rowDaySpan,
  startOfMonth,
} from "@t2code/client-runtime/spaces";
import type { SpaceDatabaseRow } from "@t2code/contracts/spaces";

export interface AgendaItem {
  readonly row: SpaceDatabaseRow;
  readonly startDay: string;
  readonly endDay: string;
}

export interface AgendaSection {
  /** The day the items sit under; an item that started earlier sits under the first day of the month. */
  readonly day: string;
  readonly items: ReadonlyArray<AgendaItem>;
}

/** First and last day of the month that starts on `month` (`YYYY-MM-01`). */
export function monthBounds(month: string): {
  readonly firstDay: string;
  readonly lastDay: string;
} {
  return { firstDay: month, lastDay: addDays(addMonths(month, 1), -1) };
}

export const stepMonth = (month: string, direction: -1 | 1): string => addMonths(month, direction);

/** The month a moment falls in, in the viewer's zone. */
export const monthOfNow = (now: number, zone: string): string => startOfMonth(isoDay(now, zone));

/** "November 2026". */
export function monthLabel(month: string): string {
  const days = dayNumber(month);
  if (days === null) return month;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(days * 86_400_000);
}

/** "Wed, Nov 11". */
export function dayLabel(day: string): string {
  const days = dayNumber(day);
  if (days === null) return day;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(days * 86_400_000);
}

/** "Nov 9 → Nov 12" for an item that spans days, else null. */
export function rangeLabel(item: AgendaItem): string | null {
  return item.endDay > item.startDay
    ? `${dayLabel(item.startDay)} → ${dayLabel(item.endDay)}`
    : null;
}

/**
 * Rows placed by their date cells into the days of one month. The span runs from the start cell to
 * the end cell when there is one (and it is not before the start), else the start cell's own range.
 * Rows without a readable date are left out; so are rows that do not touch the month.
 */
export function agendaSections(
  rows: ReadonlyArray<SpaceDatabaseRow>,
  start: string,
  end: string | null,
  month: string,
  zone: string,
): ReadonlyArray<AgendaSection> {
  const { firstDay, lastDay } = monthBounds(month);
  const byDay = new Map<string, AgendaItem[]>();
  for (const row of rows) {
    const first = rowDaySpan(row.cells[start], zone);
    if (first === null) continue;
    const last = end === null ? null : rowDaySpan(row.cells[end], zone);
    const endDay = last !== null && last.endDay >= first.startDay ? last.endDay : first.endDay;
    if (endDay < firstDay || first.startDay > lastDay) continue;
    const day = first.startDay < firstDay ? firstDay : first.startDay;
    const item: AgendaItem = { row, startDay: first.startDay, endDay };
    const list = byDay.get(day);
    if (list === undefined) byDay.set(day, [item]);
    else list.push(item);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, items]) => ({
      day,
      items: items
        .map((item, index) => ({ item, index }))
        .sort((a, b) =>
          a.item.startDay < b.item.startDay
            ? -1
            : a.item.startDay > b.item.startDay
              ? 1
              : a.index - b.index,
        )
        .map((entry) => entry.item),
    }));
}
