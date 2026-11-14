import {
  type Fields,
  MS_DAY,
  MS_HOUR,
  MS_MINUTE,
  MS_SECOND,
  addMonthsClamped,
  fieldsAt,
  fieldsOfWallMs,
  formatFields,
  isoWeek,
  normalizeZone,
  offsetAt,
  parseDateText,
  validInstant,
  wallMsOf,
  wallToInstant,
} from "../dates.ts";
import { type FnDef, asDate, asNum, asStr } from "../fn.ts";
import type { Runtime } from "../runtime.ts";
import { type DateValue, type FormulaValue, effectiveEnd, instantOf } from "../values.ts";

type Unit =
  | "year"
  | "quarter"
  | "month"
  | "week"
  | "day"
  | "hour"
  | "minute"
  | "second"
  | "millisecond";
const UNITS: ReadonlyArray<Unit> = [
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "hour",
  "minute",
  "second",
  "millisecond",
];

function normalizeUnit(text: string): Unit | undefined {
  const singular = text.endsWith("s") ? text.slice(0, -1) : text;
  return UNITS.find((u) => u === singular);
}

const unitLiteral = (index: number, value: string): string | undefined =>
  index === 2 && normalizeUnit(value) === undefined ? `Unknown unit "${value}".` : undefined;

const SMALL_MS: Partial<Record<Unit, number>> = {
  hour: MS_HOUR,
  minute: MS_MINUTE,
  second: MS_SECOND,
  millisecond: 1,
};

const zoneOf = (d: DateValue, rt: Runtime): string => normalizeZone(d.zone ?? rt.tz);

function makeDate(
  start: number,
  end: number | undefined,
  timed: boolean,
  zone?: string,
): DateValue | null {
  if (!validInstant(start) || (end !== undefined && !validInstant(end))) return null;
  return {
    kind: "date",
    start,
    ...(end === undefined ? {} : { end }),
    timed,
    ...(zone === undefined ? {} : { zone }),
  };
}

/** Wall-clock fields of the start of a date value; a date-only value has no zone. */
function fieldsOf(d: DateValue, rt: Runtime, at: number = d.start): Fields {
  return d.timed ? fieldsAt(at, zoneOf(d, rt)) : fieldsOfWallMs(at);
}

function shiftValue(
  d: DateValue,
  v: number,
  amount: number,
  unit: Unit,
  rt: Runtime,
): number | null {
  const zone = zoneOf(d, rt);
  const smallMs = SMALL_MS[unit];
  if (smallMs !== undefined) {
    const base = d.timed ? v : wallToInstant(v, zone);
    return base + amount * smallMs;
  }
  if (unit === "week" || unit === "day") {
    const days = amount * (unit === "week" ? 7 : 1);
    if (!d.timed) return v + days * MS_DAY;
    return wallToInstant(v + offsetAt(v, zone) * MS_MINUTE + days * MS_DAY, zone);
  }
  const months = amount * (unit === "year" ? 12 : unit === "quarter" ? 3 : 1);
  const f = fieldsOf(d, rt, v);
  const r = addMonthsClamped(f.y, f.mo, f.d, months);
  if (!d.timed) return wallMsOf(r.y, r.mo, r.d);
  return wallToInstant(wallMsOf(r.y, r.mo, r.d, f.h, f.mi, f.s, f.ms), zone);
}

function dateAdd(d: DateValue, amount: number, unitText: string, rt: Runtime): FormulaValue {
  const unit = normalizeUnit(unitText);
  if (unit === undefined || !Number.isFinite(amount)) return null;
  const n = Math.trunc(amount);
  const start = shiftValue(d, d.start, n, unit, rt);
  const end = d.end === undefined ? undefined : shiftValue(d, d.end, n, unit, rt);
  if (start === null || end === null) return null;
  return makeDate(start, end, d.timed || SMALL_MS[unit] !== undefined, d.zone);
}

const tailOf = (f: Fields): ReadonlyArray<number> => [f.d, f.h, f.mi, f.s, f.ms];

function compareTails(a: Fields, b: Fields): number {
  const x = tailOf(a);
  const y = tailOf(b);
  for (let i = 0; i < x.length; i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function dateBetween(a: DateValue, b: DateValue, unitText: string, rt: Runtime): FormulaValue {
  const unit = normalizeUnit(unitText);
  if (unit === undefined) return null;
  if (unit === "year" || unit === "quarter" || unit === "month") {
    const fa = fieldsOf(a, rt);
    const fb = fieldsOf(b, rt);
    let months = fa.y * 12 + fa.mo - (fb.y * 12 + fb.mo);
    const tail = compareTails(fa, fb);
    if (months > 0 && tail < 0) months -= 1;
    else if (months < 0 && tail > 0) months += 1;
    const per = unit === "year" ? 12 : unit === "quarter" ? 3 : 1;
    return Math.trunc(months / per) || 0;
  }
  const diff =
    !a.timed && !b.timed
      ? a.start - b.start
      : instantOf(a, a.start, rt.tz) - instantOf(b, b.start, rt.tz);
  const size = unit === "week" ? 7 * MS_DAY : unit === "day" ? MS_DAY : (SMALL_MS[unit] ?? 1);
  return Math.trunc(diff / size) || 0;
}

const unary = (
  name: string,
  description: string,
  pick: (f: Fields, rt: Runtime) => number,
): FnDef => ({
  name,
  signature: `${name}(date)`,
  description,
  example: `${name}(prop("Due"))`,
  category: "date",
  params: ["date"],
  min: 1,
  max: 1,
  ret: "number",
  run: ([d], rt) => {
    const date = asDate(d);
    return date === null ? null : pick(fieldsOf(date, rt), rt);
  },
});

function formatOne(
  d: DateValue,
  value: number,
  format: string,
  zoneArg: string | undefined,
  rt: Runtime,
): string {
  if (!d.timed) return formatFields(fieldsOfWallMs(value), 0, format);
  const zone = normalizeZone(zoneArg ?? d.zone ?? rt.tz);
  return formatFields(fieldsAt(value, zone), offsetAt(value, zone), format);
}

export const dateFunctions: ReadonlyArray<FnDef> = [
  {
    name: "now",
    signature: "now()",
    description: "The current date and time.",
    example: "now()",
    category: "date",
    params: [],
    min: 0,
    max: 0,
    ret: "date",
    volatile: true,
    run: (_a, rt) => makeDate(rt.ctx.now, undefined, true),
  },
  {
    name: "today",
    signature: "today()",
    description: "Today's date, without a time.",
    example: "today()",
    category: "date",
    params: [],
    min: 0,
    max: 0,
    ret: "date",
    volatile: true,
    run: (_a, rt) => {
      const f = fieldsAt(rt.ctx.now, rt.tz);
      return makeDate(wallMsOf(f.y, f.mo, f.d), undefined, false);
    },
  },
  {
    name: "parseDate",
    signature: "parseDate(text)",
    description: "A date from YYYY-MM-DD or YYYY-MM-DDTHH:mm text, with an optional Z or offset.",
    example: 'parseDate("2024-03-15")',
    category: "date",
    params: ["text"],
    min: 1,
    max: 1,
    ret: "date",
    run: ([t], rt) => {
      const parsed = parseDateText(asStr(t), rt.tz);
      return parsed === null ? null : makeDate(parsed.start, undefined, parsed.timed);
    },
  },
  {
    name: "timestamp",
    signature: "timestamp(date)",
    description: "Milliseconds since 1970-01-01 UTC.",
    example: 'timestamp(prop("Due"))',
    category: "date",
    params: ["date"],
    min: 1,
    max: 1,
    ret: "number",
    run: ([d], rt) => {
      const date = asDate(d);
      return date === null ? null : instantOf(date, date.start, rt.tz);
    },
  },
  {
    name: "fromTimestamp",
    signature: "fromTimestamp(number)",
    description: "A date from milliseconds since 1970-01-01 UTC.",
    example: "fromTimestamp(1700000000000)",
    category: "date",
    params: ["number"],
    min: 1,
    max: 1,
    ret: "date",
    run: ([n]) => makeDate(asNum(n), undefined, true),
  },
  {
    name: "formatDate",
    signature: "formatDate(date, format, timeZone?)",
    description:
      "Formats a date with tokens such as YYYY, MM, DD, HH, mm, A, dddd, MMMM and [text].",
    example: 'formatDate(prop("Due"), "MMM D, YYYY")',
    category: "date",
    params: ["date", "text", "text"],
    min: 2,
    max: 3,
    ret: "text",
    run: ([d, f, z], rt) => {
      const date = asDate(d);
      if (date === null) return null;
      const zone = typeof z === "string" && z !== "" ? z : undefined;
      const first = formatOne(date, date.start, asStr(f), zone, rt);
      return date.end === undefined
        ? first
        : `${first} → ${formatOne(date, date.end, asStr(f), zone, rt)}`;
    },
  },
  unary("minute", "The minute, 0 to 59.", (f) => f.mi),
  unary("hour", "The hour, 0 to 23.", (f) => f.h),
  unary("date", "The day of the month, 1 to 31.", (f) => f.d),
  unary("day", "The day of the week, 1 (Monday) to 7 (Sunday).", (f) => f.dow),
  unary("week", "The ISO week of the year.", (f) => isoWeek(f.y, f.mo, f.d)),
  unary("month", "The month, 1 to 12.", (f) => f.mo),
  unary("year", "The year.", (f) => f.y),
  ...(["dateAdd", "dateSubtract"] as const).map((name): FnDef => ({
    name,
    signature: `${name}(date, amount, unit)`,
    description: `${name === "dateAdd" ? "Adds to" : "Subtracts from"} a date. Units: years, quarters, months, weeks, days, hours, minutes, seconds.`,
    example: `${name}(prop("Due"), 1, "months")`,
    category: "date",
    params: ["date", "number", "unit"],
    min: 3,
    max: 3,
    ret: "date",
    literal: unitLiteral,
    run: ([d, n, u], rt) => {
      const date = asDate(d);
      return date === null
        ? null
        : dateAdd(date, name === "dateAdd" ? asNum(n) : -asNum(n), asStr(u), rt);
    },
  })),
  {
    name: "dateBetween",
    signature: "dateBetween(date, other, unit)",
    description: "The whole units from other to date; negative when date is earlier.",
    example: 'dateBetween(prop("Due"), today(), "days")',
    category: "date",
    params: ["date", "date", "unit"],
    min: 3,
    max: 3,
    ret: "number",
    literal: unitLiteral,
    run: ([a, b, u], rt) => {
      const x = asDate(a);
      const y = asDate(b);
      return x === null || y === null ? null : dateBetween(x, y, asStr(u), rt);
    },
  },
  {
    name: "dateRange",
    signature: "dateRange(start, end)",
    description: "A date range. Empty when the end is before the start.",
    example: 'dateRange(prop("Start"), prop("End"))',
    category: "date",
    params: ["date", "date"],
    min: 2,
    max: 2,
    ret: "date",
    run: ([a, b], rt) => {
      const x = asDate(a);
      const y = asDate(b);
      if (x === null || y === null) return null;
      if (!x.timed && !y.timed) return y.start < x.start ? null : makeDate(x.start, y.start, false);
      const s = instantOf(x, x.start, rt.tz);
      const e = instantOf(y, y.start, rt.tz);
      return e < s ? null : makeDate(s, e, true, x.zone ?? y.zone);
    },
  },
  {
    name: "dateStart",
    signature: "dateStart(date)",
    description: "The start of a date range.",
    example: 'dateStart(prop("Dates"))',
    category: "date",
    params: ["date"],
    min: 1,
    max: 1,
    ret: "date",
    run: ([d]) => {
      const date = asDate(d);
      return date === null ? null : makeDate(date.start, undefined, date.timed, date.zone);
    },
  },
  {
    name: "dateEnd",
    signature: "dateEnd(date)",
    description: "The end of a date range, or the date itself.",
    example: 'dateEnd(prop("Dates"))',
    category: "date",
    params: ["date"],
    min: 1,
    max: 1,
    ret: "date",
    run: ([d]) => {
      const date = asDate(d);
      return date === null ? null : makeDate(effectiveEnd(date), undefined, date.timed, date.zone);
    },
  },
];
