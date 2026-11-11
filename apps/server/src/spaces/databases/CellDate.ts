import type * as C from "@t2code/contracts/spaces";

const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/;
const dateTime =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/;

const validZone = (timeZone: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
};

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

interface Parsed {
  readonly ms: number;
  readonly hasTime: boolean;
}

const validDay = (year: number, month: number, day: number) => {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
};

function parseOne(text: string, timeZone: string | undefined): Parsed | undefined {
  const day = dateOnly.exec(text);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const ms = Date.UTC(y, m - 1, d);
    return validDay(y, m, d) ? { ms, hasTime: false } : undefined;
  }
  const time = dateTime.exec(text);
  if (!time) return undefined;
  const [y, m, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(time[i]));
  const s = Number(time[6] ?? 0);
  const fraction = Number((time[7] ?? "0").padEnd(3, "0").slice(0, 3));
  if (h! > 23 || mi! > 59 || s > 59) return undefined;
  const wall = Date.UTC(y!, m! - 1, d!, h!, mi!, s, fraction);
  if (!validDay(y!, m!, d!)) return undefined;
  const zone = time[8];
  if (zone === "Z") return { ms: wall, hasTime: true };
  if (zone) {
    const sign = zone.startsWith("-") ? -1 : 1;
    const [oh, om] = zone.slice(1).split(":").map(Number);
    return { ms: wall - sign * (oh! * 60 + om!) * 60_000, hasTime: true };
  }
  if (timeZone === undefined) return undefined;
  const first = zoneOffsetMs(wall, timeZone);
  const guess = wall - first;
  const second = zoneOffsetMs(guess, timeZone);
  return { ms: second === first ? guess : wall - second, hasTime: true };
}

/** Section 3.4 date rules; undefined when the value is not a legal date. */
export function parseDateValue(value: C.SpaceDateValue) {
  if (value.timeZone !== undefined && !validZone(value.timeZone)) return undefined;
  const start = parseOne(value.start, value.timeZone);
  if (!start) return undefined;
  if (value.end === undefined)
    return { timeStart: start.ms, timeEnd: null, hasTime: start.hasTime };
  const end = parseOne(value.end, value.timeZone);
  if (!end || end.hasTime !== start.hasTime || end.ms < start.ms) return undefined;
  return { timeStart: start.ms, timeEnd: end.ms, hasTime: start.hasTime };
}
