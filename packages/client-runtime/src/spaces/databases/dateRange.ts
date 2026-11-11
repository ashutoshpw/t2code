// @effect-diagnostics globalDate:off -- Pure calendar arithmetic on UTC day numbers; a Date is only the carrier.
import type { SpaceDateValue, SpaceFilter, SpacePropertyId } from "@t2code/contracts/spaces";

/**
 * Date math for calendar and timeline. Everything is done on wall-clock "serials" (minutes since
 * 1970-01-01 of the wall time shown to the user), so time of day survives a daylight-saving change
 * and no caller touches `Date` arithmetic. Date-only values never go through a zone.
 */

const MINUTES_PER_DAY = 1440;
const DAY_MS = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;
const TIME_PATTERN = /T(\d{2}):(\d{2})(:\d{2}(?:\.\d+)?)?/;
const OFFSET_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/;

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

/** Days since 1970-01-01 of a `YYYY-MM-DD` string; null when it does not start with a real day. */
export function dayNumber(day: string): number | null {
  const match = DAY_PATTERN.exec(day);
  if (match === null) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Date.UTC maps the years 0 to 99 onto 1900 to 1999.
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, date);
  const ms = check.getTime();
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  return Math.round(ms / DAY_MS);
}

export function dayFromNumber(days: number): string {
  const date = new Date(days * DAY_MS);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export const addDays = (day: string, delta: number): string =>
  dayFromNumber((dayNumber(day) ?? 0) + delta);

/** 0 = Sunday. */
export const weekdayOf = (day: string): number => ((((dayNumber(day) ?? 0) + 4) % 7) + 7) % 7;

/** First day of the week containing `day`. */
export function startOfWeek(day: string, weekStart: "sunday" | "monday"): string {
  const offset = (weekdayOf(day) - (weekStart === "monday" ? 1 : 0) + 7) % 7;
  return addDays(day, -offset);
}

export const startOfMonth = (day: string): string => `${day.slice(0, 7)}-01`;

/** First of the month `delta` months from the month of `day`. */
export function addMonths(day: string, delta: number): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7)) - 1 + delta;
  const date = new Date(Date.UTC(year, month, 1));
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-01`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** Wall-clock minutes of an instant in a zone. An unknown zone falls back to UTC. */
function wallSerialOf(ms: number, zone: string): number {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = formatterFor(zone);
  } catch {
    formatter = formatterFor("UTC");
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Math.floor(
    Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!) / 60_000,
  );
}

/** The calendar day of an instant in a zone. */
export const isoDay = (ms: number, zone: string): string =>
  dayFromNumber(Math.floor(wallSerialOf(ms, zone) / MINUTES_PER_DAY));

/** The day string of a wall serial. */
export const serialDay = (serial: number): string =>
  dayFromNumber(Math.floor(serial / MINUTES_PER_DAY));

/** `HH:mm` of a wall serial. */
export function serialTime(serial: number): string {
  const minutes = ((serial % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export interface WallStamp {
  /** Wall-clock minutes since 1970-01-01; date-only values sit at midnight. */
  readonly serial: number;
  readonly timed: boolean;
  /** `:SS` or `:SS.mmm` of the stored time; a move keeps it, the serial counts whole minutes. */
  readonly seconds?: string;
}

const secondsOf = (text: string | undefined) => (text === undefined ? {} : { seconds: text });

/** Reads a stored `start` or `end`. Strings carrying an offset or `Z` are shown in `zone`. */
function readStamp(stamp: string, zone: string): WallStamp | null {
  const days = dayNumber(stamp);
  if (days === null) return null;
  const time = TIME_PATTERN.exec(stamp);
  if (time === null) return { serial: days * MINUTES_PER_DAY, timed: false };
  if (OFFSET_PATTERN.test(stamp)) {
    const normalized = stamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const ms = Date.parse(normalized);
    if (Number.isNaN(ms)) return null;
    return { serial: wallSerialOf(ms, zone), timed: true, ...secondsOf(time[3]) };
  }
  return {
    serial: days * MINUTES_PER_DAY + Number(time[1]) * 60 + Number(time[2]),
    timed: true,
    ...secondsOf(time[3]),
  };
}

export interface ReadDate {
  readonly start: WallStamp;
  readonly end: WallStamp | null;
  /** Zone the wall times are in; null for date-only values. */
  readonly zone: string | null;
}

const isDateValue = (value: unknown): value is SpaceDateValue =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "start") === "string";

/** Null when the cell holds no readable date. An end that is not a date is ignored. */
export function readDateValue(value: unknown, viewerZone: string): ReadDate | null {
  // created_time and last_edited_time cells are bare ISO instants.
  if (typeof value === "string") return readDateValue({ start: value }, viewerZone);
  // A formula or rollup cell wraps its date: `{ type: "date", value: { start, ... } }`.
  if (typeof value === "object" && value !== null && "type" in value && value.type === "date")
    return "value" in value ? readDateValue(value.value, viewerZone) : null;
  if (!isDateValue(value)) return null;
  const zone = value.timeZone ?? viewerZone;
  const start = readStamp(value.start, zone);
  if (start === null) return null;
  const end = value.end === undefined ? null : readStamp(value.end, zone);
  return {
    start,
    end: end !== null && end.serial >= start.serial ? end : null,
    zone: start.timed ? zone : null,
  };
}

/** The days a value covers, both inclusive: floating for date-only values, in the value's zone otherwise. */
export function rowDaySpan(
  value: unknown,
  timeZone: string,
): { readonly startDay: string; readonly endDay: string } | null {
  const read = readDateValue(value, timeZone);
  if (read === null) return null;
  const startDay = serialDay(read.start.serial);
  const endDay = read.end === null ? startDay : serialDay(read.end.serial);
  return { startDay, endDay };
}

function formatSerial(serial: number, timed: boolean, seconds = ":00"): string {
  const day = serialDay(serial);
  return timed ? `${day}T${serialTime(serial)}${seconds}` : day;
}

/**
 * Moves the start and the end by minutes. Date-only values move by whole days. An end that would
 * fall before the start is raised to it, and an end equal to the start is dropped.
 */
export function moveDateValue(
  value: unknown,
  move: { readonly startMinutes: number; readonly endMinutes: number },
  viewerZone: string,
): SpaceDateValue | null {
  const read = readDateValue(value, viewerZone);
  if (read === null) return null;
  const timed = read.start.timed;
  const unit = timed ? 1 : MINUTES_PER_DAY;
  const snap = (minutes: number) => Math.round(minutes / unit) * unit;
  const base = (read.end ?? read.start).serial;
  const moved = base + snap(move.endMinutes);
  const shifted = read.start.serial + snap(move.startMinutes);
  // Dragging only the start edge past the end stops at the end.
  const start = move.endMinutes === 0 && shifted > moved ? moved : shifted;
  const end = Math.max(start, moved);
  const keepEnd = end > start;
  return {
    start: formatSerial(start, timed, read.start.seconds),
    ...(keepEnd ? { end: formatSerial(end, timed, (read.end ?? read.start).seconds) } : {}),
    ...(timed ? { timeZone: read.zone ?? viewerZone } : {}),
  };
}

/** Moves a whole value by days, keeping the time of day, the duration and the zone. */
export function shiftDateValue(
  value: unknown,
  deltaDays: number,
  viewerZone = "UTC",
): SpaceDateValue | null {
  const minutes = deltaDays * MINUTES_PER_DAY;
  return moveDateValue(value, { startMinutes: minutes, endMinutes: minutes }, viewerZone);
}

/** Moves one edge by days: never below one day long (a single day has no end). */
export function resizeDateValue(
  value: unknown,
  edge: "start" | "end",
  deltaDays: number,
  viewerZone = "UTC",
): SpaceDateValue | null {
  const minutes = deltaDays * MINUTES_PER_DAY;
  return moveDateValue(
    value,
    edge === "start"
      ? { startMinutes: minutes, endMinutes: 0 }
      : { startMinutes: 0, endMinutes: minutes },
    viewerZone,
  );
}

/** The two filters that match every row whose date overlaps `[firstDay, lastDay]`. */
export function overlapFilter(
  propertyId: SpacePropertyId,
  propertyType: string,
  firstDay: string,
  lastDay: string,
): SpaceFilter {
  return rangeOverlapFilter({ id: propertyId, type: propertyType }, undefined, firstDay, lastDay);
}

/**
 * Rows whose start falls on or before `lastDay` and whose end (the end property, else the start)
 * falls on or after `firstDay`. A `date` property carries both ends and is filtered by part.
 */
export function rangeOverlapFilter(
  start: { readonly id: SpacePropertyId; readonly type: string },
  end: { readonly id: SpacePropertyId; readonly type: string } | undefined,
  firstDay: string,
  lastDay: string,
): SpaceFilter {
  const endProperty = end ?? start;
  return {
    and: [
      {
        property: start.id,
        operator: "on_or_before",
        value: lastDay,
        ...(start.type === "date" ? { part: "start" as const } : {}),
      },
      {
        property: endProperty.id,
        operator: "on_or_after",
        value: firstDay,
        ...(endProperty.type === "date" ? { part: "end" as const } : {}),
      },
    ],
  };
}

export const emptyDateFilter = (propertyId: SpacePropertyId): SpaceFilter => ({
  property: propertyId,
  operator: "is_empty",
});
