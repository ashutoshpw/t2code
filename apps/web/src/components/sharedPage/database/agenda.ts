// @effect-diagnostics globalDate:off -- Formats a calendar day string; the Date is only a carrier.
import {
  addDays,
  addMonths,
  dayNumber,
  rowDaySpan,
  startOfMonth,
} from "@t2code/client-runtime/spaces";
import type { SpaceSharedDatabaseRow } from "@t2code/contracts";

const DAY_MS = 86_400_000;

/** First and last day of the month that contains `day`. */
export function monthRange(day: string) {
  const from = startOfMonth(day);
  return { from, to: addDays(addMonths(from, 1), -1) };
}

export function monthLabel(day: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format((dayNumber(day) ?? 0) * DAY_MS);
}

export function dayLabel(day: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format((dayNumber(day) ?? 0) * DAY_MS);
}

export interface AgendaSection {
  readonly day: string;
  readonly rows: ReadonlyArray<SpaceSharedDatabaseRow>;
}

/** Rows listed under the day they start; one that began earlier goes under the first day. */
export function agendaSections(
  rows: ReadonlyArray<SpaceSharedDatabaseRow>,
  startId: string,
  range: { readonly from: string; readonly to: string },
  zone: string,
): ReadonlyArray<AgendaSection> {
  const days = new Map<string, SpaceSharedDatabaseRow[]>();
  for (const row of rows) {
    const span = rowDaySpan(row.cells[startId], zone);
    if (span === null) continue;
    const day = span.startDay < range.from ? range.from : span.startDay;
    const list = days.get(day);
    if (list === undefined) days.set(day, [row]);
    else list.push(row);
  }
  return [...days.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, list]) => ({ day, rows: list }));
}
