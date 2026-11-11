import {
  addDays,
  addMonths,
  startOfMonth,
  startOfWeek,
  weekdayOf,
} from "@t2code/client-runtime/spaces";

export type CalendarMode = "month" | "week";
export type WeekStart = "sunday" | "monday";

export interface CalendarRange {
  /** First and last visible day, inclusive, whole weeks. */
  readonly firstDay: string;
  readonly lastDay: string;
  /** Week start days, in order. */
  readonly weeks: ReadonlyArray<string>;
}

/** Month mode: the whole weeks covering the month of `anchor`. Week mode: the week of `anchor`. */
export function calendarRange(
  anchor: string,
  mode: CalendarMode,
  weekStart: WeekStart,
): CalendarRange {
  if (mode === "week") {
    const first = startOfWeek(anchor, weekStart);
    return { firstDay: first, lastDay: addDays(first, 6), weeks: [first] };
  }
  const monthStart = startOfMonth(anchor);
  const first = startOfWeek(monthStart, weekStart);
  const nextMonth = addMonths(monthStart, 1);
  const last = addDays(startOfWeek(addDays(nextMonth, -1), weekStart), 6);
  const weeks: string[] = [];
  for (let week = first; week < nextMonth; week = addDays(week, 7)) weeks.push(week);
  return { firstDay: first, lastDay: last, weeks };
}

/** The day columns of a week: weekends are dropped from the grid but stay in the range. */
export function weekColumns(weekFirstDay: string, showWeekends: boolean): ReadonlyArray<string> {
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekFirstDay, index));
  return showWeekends ? days : days.filter((day) => weekdayOf(day) !== 0 && weekdayOf(day) !== 6);
}

/** The anchor after `‹` or `›`: a month or a week at a time. */
export function stepAnchor(anchor: string, mode: CalendarMode, direction: -1 | 1): string {
  return mode === "week" ? addDays(anchor, 7 * direction) : addMonths(anchor, direction);
}
