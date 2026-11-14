import {
  addDays,
  addMonths,
  dayFromNumber,
  dayNumber,
  startOfWeek,
} from "@t2code/client-runtime/spaces";

export const ZOOMS = ["hours", "day", "week", "biweek", "month", "quarter", "year"] as const;
export type Zoom = (typeof ZOOMS)[number];

export const DEFAULT_ZOOM: Zoom = "month";
export const ROW_HEIGHT = 36;
export const HEADER_TIER_HEIGHT = 24;

export const PX_PER_DAY: Record<Zoom, number> = {
  hours: 960,
  day: 120,
  week: 40,
  biweek: 20,
  month: 10,
  quarter: 4,
  year: 1.5,
};

/** Days the canvas covers around the anchor. */
export const SPAN_DAYS: Record<Zoom, number> = {
  hours: 14,
  day: 120,
  week: 365,
  biweek: 730,
  month: 1461,
  quarter: 3652,
  year: 10957,
};

const MINUTES_PER_DAY = 1440;

export interface Scale {
  readonly zoom: Zoom;
  readonly pxPerDay: number;
  /** First day of the canvas, as a day number. */
  readonly originDay: number;
  readonly days: number;
  readonly width: number;
}

export function makeScale(zoom: Zoom, anchorDay: string): Scale {
  const days = SPAN_DAYS[zoom];
  const originDay = (dayNumber(anchorDay) ?? 0) - Math.floor(days / 2);
  return {
    zoom,
    pxPerDay: PX_PER_DAY[zoom],
    originDay,
    days,
    width: Math.round(days * PX_PER_DAY[zoom]),
  };
}

/** X of a wall-clock serial (minutes since 1970-01-01). */
export const serialToX = (scale: Scale, serial: number): number =>
  ((serial - scale.originDay * MINUTES_PER_DAY) / MINUTES_PER_DAY) * scale.pxPerDay;

/** Wall-clock serial at an x, rounded to the minute. */
export const xToSerial = (scale: Scale, x: number): number =>
  Math.round(scale.originDay * MINUTES_PER_DAY + (x / scale.pxPerDay) * MINUTES_PER_DAY);

export const dayToX = (scale: Scale, day: string): number =>
  serialToX(scale, (dayNumber(day) ?? scale.originDay) * MINUTES_PER_DAY);

/** The calendar day under an x. */
export const xToDay = (scale: Scale, x: number): string =>
  dayFromNumber(Math.floor(xToSerial(scale, x) / MINUTES_PER_DAY));

/** Minutes one drag step moves: a quarter of an hour at hour zoom for timed values, else a day. */
export const snapMinutes = (zoom: Zoom, timed: boolean): number =>
  zoom === "hours" && timed ? 15 : MINUTES_PER_DAY;

/** Pixels to snapped minutes, rounded to the nearest step. */
export function deltaToMinutes(scale: Scale, deltaX: number, snap: number): number {
  const minutes = (deltaX / scale.pxPerDay) * MINUTES_PER_DAY;
  return Math.round(minutes / snap) * snap;
}

export interface Tick {
  readonly key: string;
  readonly x: number;
  readonly width: number;
  readonly label: string;
}

type Unit = "hour" | "day" | "week" | "biweek" | "month" | "quarter" | "year" | "decade";

const TIERS: Record<Zoom, readonly [Unit, Unit]> = {
  hours: ["day", "hour"],
  day: ["month", "day"],
  week: ["month", "week"],
  biweek: ["month", "biweek"],
  month: ["year", "month"],
  quarter: ["year", "quarter"],
  year: ["decade", "year"],
};

const utcDate = (day: string) => new Date(`${day}T00:00:00Z`);
const fmt = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" });
const FORMATS = {
  hourDay: fmt({ weekday: "short", month: "short", day: "numeric" }),
  month: fmt({ month: "long", year: "numeric" }),
  monthShort: fmt({ month: "short" }),
  dayShort: fmt({ day: "numeric" }),
  dayMonth: fmt({ month: "short", day: "numeric" }),
};

const startOf = (unit: Exclude<Unit, "hour">, day: string): string => {
  switch (unit) {
    case "day":
      return day;
    case "week":
      return startOfWeek(day, "monday");
    case "biweek": {
      // Fixed fortnights counted from a Monday, so the grid never shifts with the anchor.
      const week = startOfWeek(day, "monday");
      const weeks = Math.floor(((dayNumber(week) ?? 0) - 4) / 7);
      return weeks % 2 === 0 ? week : addDays(week, -7);
    }
    case "month":
      return `${day.slice(0, 7)}-01`;
    case "quarter": {
      const month = Number(day.slice(5, 7));
      const first = Math.floor((month - 1) / 3) * 3 + 1;
      return `${day.slice(0, 4)}-${String(first).padStart(2, "0")}-01`;
    }
    case "year":
      return `${day.slice(0, 4)}-01-01`;
    case "decade":
      return `${Math.floor(Number(day.slice(0, 4)) / 10) * 10}-01-01`;
  }
};

const next = (unit: Exclude<Unit, "hour">, start: string): string => {
  switch (unit) {
    case "day":
      return addDays(start, 1);
    case "week":
      return addDays(start, 7);
    case "biweek":
      return addDays(start, 14);
    case "month":
      return addMonths(start, 1);
    case "quarter":
      return addMonths(start, 3);
    case "year":
      return addMonths(start, 12);
    case "decade":
      return addMonths(start, 120);
  }
};

function label(unit: Unit, zoom: Zoom, start: string): string {
  const date = utcDate(start);
  switch (unit) {
    case "day":
      return zoom === "hours" ? FORMATS.hourDay.format(date) : FORMATS.dayShort.format(date);
    case "week":
    case "biweek":
      return FORMATS.dayMonth.format(date);
    case "month":
      return zoom === "month" ? FORMATS.monthShort.format(date) : FORMATS.month.format(date);
    case "quarter":
      return `Q${Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1}`;
    case "year":
      return start.slice(0, 4);
    case "decade":
      return `${start.slice(0, 4)}s`;
    case "hour":
      return "";
  }
}

/** Header ticks of one tier that intersect `[fromX, toX]`. Hour ticks are 24 per day. */
export function ticks(scale: Scale, tier: "top" | "bottom", fromX: number, toX: number): Tick[] {
  const unit = TIERS[scale.zoom][tier === "top" ? 0 : 1];
  const out: Tick[] = [];
  if (unit === "hour") {
    const hourPx = scale.pxPerDay / 24;
    const first = Math.max(0, Math.floor(fromX / hourPx));
    const last = Math.min(scale.days * 24 - 1, Math.floor(toX / hourPx));
    for (let hour = first; hour <= last; hour++) {
      out.push({
        key: `h${hour}`,
        x: hour * hourPx,
        width: hourPx,
        label: String(hour % 24).padStart(2, "0"),
      });
    }
    return out;
  }
  const firstDay = dayFromNumber(
    Math.floor(xToSerial(scale, Math.max(0, fromX)) / MINUTES_PER_DAY),
  );
  let start = startOf(unit, firstDay);
  for (let guard = 0; guard < 2000; guard++) {
    const x = dayToX(scale, start);
    if (x > toX || x > scale.width) break;
    const after = next(unit, start);
    const endX = dayToX(scale, after);
    out.push({ key: `${unit}${start}`, x, width: endX - x, label: label(unit, scale.zoom, start) });
    start = after;
  }
  return out;
}

/** Vertical window of fixed-height rows: `first` inclusive, `last` exclusive, with overscan. */
export function rowWindow(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = ROW_HEIGHT,
  overscan = 6,
): { readonly first: number; readonly last: number } {
  if (count <= 0) return { first: 0, last: 0 };
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan);
  const last = Math.min(
    count,
    Math.ceil((Math.max(0, scrollTop) + viewportHeight) / rowHeight) + overscan,
  );
  return { first: Math.min(first, count), last };
}
