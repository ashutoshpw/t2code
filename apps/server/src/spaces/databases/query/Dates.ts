import * as C from "@t2code/contracts/spaces";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { parseDateValue } from "../CellDate.ts";
import { dbError, isoNow } from "../Types.ts";

/** The viewer's calendar for one query; `nowMs` is the read's observed time, never the wall clock. */
export interface DateContext {
  readonly nowMs: number;
  readonly timeZone: string;
  readonly zone: DateTime.TimeZone.Named;
  readonly weekStartsOn: 0 | 1;
  /** The zone's UTC offset at `nowMs`, applied to every value when bucketing. */
  readonly offsetMs: number;
}

/** A calendar day or span as `[lo, hi)`, in both encodings (section 4.3). */
export interface Bounds {
  /** UTC midnight of the calendar dates: how date-only cells are stored. */
  readonly fLo: number;
  readonly fHi: number;
  /** The instants at which those days begin in the viewer's zone. */
  readonly iLo: number;
  readonly iHi: number;
}
export interface Operand {
  readonly day: Bounds;
  /** Set when the operand is a date-time. */
  readonly instant?: number;
}

export const makeContext = Effect.fn("SpacesDatabases.dateContext")(function* (
  nowMs: number,
  timeZone: string,
  weekStart: "sunday" | "monday" | undefined,
) {
  const zone = Option.getOrUndefined(DateTime.zoneMakeNamed(timeZone));
  if (zone === undefined) return yield* dbError("invalid_time_zone");
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(nowMs, { timeZone: zone }));
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  return {
    nowMs,
    timeZone,
    zone,
    weekStartsOn: weekStart === "monday" ? 1 : 0,
    offsetMs: wall - nowMs,
  } satisfies DateContext;
});

type Zoned = DateTime.Zoned;

const zonedAt = (ctx: DateContext, ms: number) =>
  DateTime.makeZonedUnsafe(ms, { timeZone: ctx.zone });
const dayStart = (value: Zoned) => DateTime.startOf(value, "day");
const nextDay = (value: Zoned) => dayStart(DateTime.add(dayStart(value), { days: 1 }));
const floating = (value: Zoned) => {
  const parts = DateTime.toParts(value);
  return Date.UTC(parts.year, parts.month - 1, parts.day);
};
const boundsOf = (lo: Zoned, hi: Zoned): Bounds => ({
  fLo: floating(lo),
  fHi: floating(hi),
  iLo: DateTime.toEpochMillis(lo),
  iHi: DateTime.toEpochMillis(hi),
});
const dayOf = (value: Zoned) => boundsOf(dayStart(value), nextDay(value));

/** The viewer's calendar day that starts at the floating (UTC-midnight) date `ms`. */
const calendarDay = (ctx: DateContext, floatingMs: number) => {
  const date = instantIso(floatingMs).slice(0, 10);
  const noon = parseDateValue({ start: `${date}T12:00`, timeZone: ctx.timeZone });
  return dayOf(zonedAt(ctx, noon!.timeStart));
};

const addUnit = (value: Zoned, unit: "day" | "week" | "month" | "year", count: number) =>
  unit === "day"
    ? DateTime.add(value, { days: count })
    : unit === "week"
      ? DateTime.add(value, { days: 7 * count })
      : unit === "month"
        ? DateTime.add(value, { months: count })
        : DateTime.add(value, { years: count });

const today = (ctx: DateContext) => zonedAt(ctx, ctx.nowMs);

const relativeDay = (ctx: DateContext, relative: (typeof C.SPACE_RELATIVE_DATES)[number]) => {
  const now = today(ctx);
  switch (relative) {
    case "today":
      return dayOf(now);
    case "tomorrow":
      return dayOf(addUnit(now, "day", 1));
    case "yesterday":
      return dayOf(addUnit(now, "day", -1));
    case "one_week_ago":
      return dayOf(addUnit(now, "week", -1));
    case "one_week_from_now":
      return dayOf(addUnit(now, "week", 1));
    case "one_month_ago":
      return dayOf(addUnit(now, "month", -1));
    case "one_month_from_now":
      return dayOf(addUnit(now, "month", 1));
  }
};

/** Resolves a validated operand: a day, or an instant together with its day. */
export const resolveOperand = (ctx: DateContext, value: unknown): Operand | undefined => {
  if (typeof value === "object" && value !== null && "relative" in value)
    return {
      day: relativeDay(ctx, value.relative as (typeof C.SPACE_RELATIVE_DATES)[number]),
    };
  if (typeof value !== "string") return undefined;
  const parsed = parseDateValue({ start: value, timeZone: ctx.timeZone });
  if (!parsed) return undefined;
  if (!parsed.hasTime) return { day: calendarDay(ctx, parsed.timeStart) };
  return { day: dayOf(zonedAt(ctx, parsed.timeStart)), instant: parsed.timeStart };
};

/** The span of a `within` operand. */
export const resolveWithin = (ctx: DateContext, operand: C.SpaceWithinOperand): Bounds => {
  const now = today(ctx);
  const count = operand.count ?? 1;
  const { direction, unit } = operand;
  if (direction === "past") return boundsOf(dayStart(addUnit(now, unit, -count)), nextDay(now));
  if (direction === "next") return boundsOf(dayStart(now), nextDay(addUnit(now, unit, count)));
  const lo =
    unit === "day"
      ? dayStart(now)
      : DateTime.startOf(now, unit, unit === "week" ? { weekStartsOn: ctx.weekStartsOn } : {});
  return boundsOf(lo, dayStart(addUnit(lo, unit, 1)));
};

export const instantIso = isoNow;

/** First day of the bucket's next unit, as floating milliseconds. */
export const bucketBounds = (start: string, unit: "day" | "week" | "month" | "year") => {
  const [y, m, d] = start.split("-").map(Number) as [number, number, number];
  const lo = Date.UTC(y, m - 1, d);
  const hi =
    unit === "day"
      ? Date.UTC(y, m - 1, d + 1)
      : unit === "week"
        ? Date.UTC(y, m - 1, d + 7)
        : unit === "month"
          ? Date.UTC(y, m, 1)
          : Date.UTC(y + 1, 0, 1);
  return { lo, hi };
};

/** "YYYY-MM-DD" bucket keys are validated before they reach SQL. */
export const validBucketStart = (start: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(start) && parseDateValue({ start }) !== undefined;
