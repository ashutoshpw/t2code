import type { SpaceDateValue } from "@t2code/contracts/spaces";

/** What the date editor edits: zone-less day strings and `HH:mm` times, or "" when absent. */
export interface DateDraft {
  readonly startDate: string;
  readonly startTime: string;
  readonly endDate: string;
  readonly endTime: string;
  readonly hasEnd: boolean;
  readonly hasTime: boolean;
}

export const EMPTY_DATE_DRAFT: DateDraft = {
  startDate: "",
  startTime: "",
  endDate: "",
  endTime: "",
  hasEnd: false,
  hasTime: false,
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})/;

const splitStamp = (stamp: string | undefined): { date: string; time: string } => {
  if (stamp === undefined) return { date: "", time: "" };
  const date = DAY.exec(stamp) ? stamp.slice(0, 10) : "";
  const time = /T(\d{2}:\d{2})/.exec(stamp)?.[1] ?? "";
  return { date, time };
};

export function parseDateValue(value: SpaceDateValue | null | undefined): DateDraft {
  if (value === null || value === undefined || typeof value.start !== "string")
    return EMPTY_DATE_DRAFT;
  const start = splitStamp(value.start);
  const end = splitStamp(value.end);
  const hasTime = start.time !== "";
  return {
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    hasEnd: end.date !== "",
    hasTime,
  };
}

const stamp = (date: string, time: string, hasTime: boolean) =>
  hasTime ? `${date}T${time === "" ? "00:00" : time}:00` : date;

/** Null when there is no start day. An end before the start is raised to the start. */
export function buildDateValue(draft: DateDraft, timeZone: string): SpaceDateValue | null {
  if (draft.startDate === "") return null;
  const start = stamp(draft.startDate, draft.startTime, draft.hasTime);
  let end: string | undefined;
  if (draft.hasEnd && draft.endDate !== "") {
    end = stamp(draft.endDate, draft.endTime, draft.hasTime);
    if (end < start) end = start;
  }
  return {
    start,
    ...(end === undefined ? {} : { end }),
    ...(draft.hasTime ? { timeZone } : {}),
  };
}

const isRealDay = (year: number, month: number, day: number) => {
  // @effect-diagnostics-next-line globalDate:off
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

/** `YYYY-MM-DD`, `YYYY/M/D` or `M/D/YYYY` to `YYYY-MM-DD`; null when it is not a real day. */
export function parseTypedDay(text: string): string | null {
  const value = text.trim();
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const parts = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : us
      ? [Number(us[3]), Number(us[1]), Number(us[2])]
      : null;
  if (parts === null) return null;
  const [year, month, day] = parts as [number, number, number];
  return isRealDay(year, month, day) ? `${pad(year, 4)}-${pad(month)}-${pad(day)}` : null;
}

/** A local-midnight Date for the Calendar; undefined for "". */
export function dayToDate(day: string): Date | undefined {
  const match = DAY.exec(day);
  // @effect-diagnostics-next-line globalDate:off
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
}

export const dateToDay = (date: Date) =>
  `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
