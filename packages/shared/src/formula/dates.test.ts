import { describe, expect, it } from "vite-plus/test";
import { fieldsAt, isoWeek, offsetAt, wallMsOf, wallToInstant } from "./dates.ts";
import type { FormulaValue } from "./index.ts";
import { NOW, ev, instant, type Store } from "./testkit.ts";

const NY = "America/New_York";
const BERLIN = "Europe/Berlin";
const KOLKATA = "Asia/Kolkata";
const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi, s);
const zoned = (source: string, timeZone: string, store: Store = {}): FormulaValue =>
  ev(source, store, { timeZone });
const start = (v: FormulaValue): number =>
  typeof v === "object" && v !== null && "start" in v ? v.start : Number.NaN;

describe("zone offsets", () => {
  it.each([
    [NY, utc(2024, 1, 15), -300],
    [NY, utc(2024, 7, 15), -240],
    [NY, utc(2024, 3, 10, 6, 59, 59), -300],
    [NY, utc(2024, 3, 10, 7, 0, 0), -240],
    [NY, utc(2024, 11, 3, 5, 59, 59), -240],
    [NY, utc(2024, 11, 3, 6, 0, 0), -300],
    [BERLIN, utc(2024, 1, 15), 60],
    [BERLIN, utc(2024, 7, 15), 120],
    [BERLIN, utc(2024, 3, 31, 0, 59, 59), 60],
    [BERLIN, utc(2024, 3, 31, 1, 0, 0), 120],
    [KOLKATA, utc(2024, 1, 15), 330],
    [KOLKATA, utc(2024, 7, 15), 330],
    ["UTC", utc(2024, 7, 15), 0],
    ["Pacific/Chatham", utc(2024, 1, 15), 825],
  ])("%s at %i is %i minutes", (zone, at, expected) => {
    expect(offsetAt(at, zone)).toBe(expected);
  });

  it("resolves a skipped wall time forward and a repeated one to the earlier offset", () => {
    expect(wallToInstant(wallMsOf(2024, 3, 10, 2, 30), NY)).toBe(utc(2024, 3, 10, 7, 30));
    expect(wallToInstant(wallMsOf(2024, 11, 3, 1, 30), NY)).toBe(utc(2024, 11, 3, 5, 30));
    expect(wallToInstant(wallMsOf(2024, 3, 31, 2, 30), BERLIN)).toBe(utc(2024, 3, 31, 1, 30));
    expect(wallToInstant(wallMsOf(2024, 10, 27, 2, 30), BERLIN)).toBe(utc(2024, 10, 27, 0, 30));
    expect(wallToInstant(wallMsOf(2024, 6, 1, 9, 0), KOLKATA)).toBe(utc(2024, 6, 1, 3, 30));
  });

  it("reads calendar fields in a zone", () => {
    expect(fieldsAt(utc(2024, 3, 15, 20, 0), KOLKATA)).toMatchObject({
      y: 2024,
      mo: 3,
      d: 16,
      h: 1,
      mi: 30,
    });
    expect(fieldsAt(utc(2024, 3, 15, 3, 0), NY)).toMatchObject({ d: 14, h: 23 });
  });

  it("treats an unknown zone as UTC", () => {
    expect(offsetAt(utc(2024, 7, 15), "Mars/Phobos")).toBe(0);
    expect(zoned('hour(parseDate("2024-03-15T12:00Z"))', "Mars/Phobos")).toBe(12);
  });

  it.each([
    [2024, 12, 30, 1],
    [2024, 1, 1, 1],
    [2021, 1, 3, 53],
    [2020, 12, 31, 53],
    [2023, 1, 1, 52],
    [2026, 1, 1, 1],
    [2024, 3, 15, 11],
  ])("ISO week of %i-%i-%i is %i", (y, m, d, week) => {
    expect(isoWeek(y, m, d)).toBe(week);
  });
});

describe("calendar fields", () => {
  const due = (ms: number, zone?: string): Store => ({ row1: { t_due: instant(ms, zone) } });
  it.each([
    ["minute", 5],
    ["hour", 13],
    ["date", 15],
    ["day", 5],
    ["week", 11],
    ["month", 3],
    ["year", 2024],
  ])("%s of a timed date", (fn, expected) => {
    expect(ev(`${fn}(parseDate("2024-03-15T13:05:09Z"))`)).toBe(expected);
  });

  it("numbers weekdays from Monday = 1 to Sunday = 7", () => {
    expect(ev('day(parseDate("2024-03-18"))')).toBe(1);
    expect(ev('day(parseDate("2024-03-17"))')).toBe(7);
    expect(ev('day(parseDate("2024-03-16"))')).toBe(6);
  });

  it("uses the context zone for timed values and no zone for date-only values", () => {
    expect(zoned('hour(parseDate("2024-03-15T12:00Z"))', NY)).toBe(8);
    expect(zoned('date(parseDate("2024-03-15"))', NY)).toBe(15);
    expect(zoned('hour(parseDate("2024-03-15"))', NY)).toBe(0);
    expect(zoned('date(parseDate("2024-03-15T02:00Z"))', NY)).toBe(14);
  });

  it("uses the value's own zone before the context zone", () => {
    const store = due(utc(2024, 3, 15, 20, 0), KOLKATA);
    expect(ev('hour(prop("Due"))', store)).toBe(1);
    expect(ev('date(prop("Due"))', store)).toBe(16);
    expect(ev('format(prop("Due"))', store)).toBe("March 16, 2024 1:30 AM");
    expect(ev('hour(prop("Due"))', due(utc(2024, 3, 15, 20, 0)))).toBe(20);
  });

  it("gives empty for an empty date", () => {
    for (const fn of ["minute", "hour", "date", "day", "week", "month", "year", "timestamp"]) {
      expect(ev(`${fn}(prop("Due"))`)).toBeNull();
    }
  });
});

describe("formatDate", () => {
  const at = 'parseDate("2024-03-15T13:05:09Z")';
  it.each([
    ["YYYY-MM-DD HH:mm:ss", "2024-03-15 13:05:09"],
    ["MMMM Do, YYYY", "March 15th, 2024"],
    ["MMM D", "Mar 15"],
    ["dddd", "Friday"],
    ["ddd", "Fri"],
    ["d", "5"],
    ["h:mm A", "1:05 PM"],
    ["hh:mm a", "01:05 pm"],
    ["YY/M/D", "24/3/15"],
    ["H:m:s", "13:5:9"],
    ["Z", "+00:00"],
    ["ZZ", "+0000"],
    ["[YYYY] YYYY", "YYYY 2024"],
    ["[at] HH", "at 13"],
    ["", ""],
    ["--- /!", "--- /!"],
  ])("formats %s", (format, expected) => {
    expect(ev(`formatDate(${at}, ${JSON.stringify(format)})`)).toBe(expected);
  });

  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [11, "11th"],
    [12, "12th"],
    [13, "13th"],
    [21, "21st"],
    [22, "22nd"],
    [23, "23rd"],
    [30, "30th"],
  ])("writes the ordinal of day %i as %s", (d, text) => {
    expect(ev(`formatDate(parseDate("2024-03-${String(d).padStart(2, "0")}"), "Do")`)).toBe(text);
  });

  it("formats in another zone, with offsets", () => {
    expect(ev(`formatDate(${at}, "YYYY-MM-DD HH:mm Z", "${KOLKATA}")`)).toBe(
      "2024-03-15 18:35 +05:30",
    );
    expect(ev(`formatDate(${at}, "HH:mm ZZ", "${NY}")`)).toBe("09:05 -0400");
    expect(ev(`formatDate(${at}, "HH:mm", "Nowhere/Land")`)).toBe("13:05");
    expect(zoned(`formatDate(${at}, "HH:mm Z")`, NY)).toBe("09:05 -04:00");
  });

  it("shows date-only values without a time shift", () => {
    expect(
      zoned('formatDate(parseDate("2024-03-15"), "YYYY-MM-DD HH:mm Z", "Asia/Kolkata")', NY),
    ).toBe("2024-03-15 00:00 +00:00");
  });

  it("formats both ends of a range", () => {
    expect(
      ev('formatDate(dateRange(parseDate("2024-03-15"), parseDate("2024-03-17")), "MMM D")'),
    ).toBe("Mar 15 → Mar 17");
  });

  it("is empty for an empty date", () => {
    expect(ev('formatDate(prop("Due"), "YYYY")')).toBeNull();
  });
});

describe("parseDate", () => {
  it.each([
    ["2024-03-15", { start: utc(2024, 3, 15), timed: false }],
    ["2024-03-15T13:05", { start: utc(2024, 3, 15, 13, 5), timed: true }],
    ["2024-03-15T13:05:09", { start: utc(2024, 3, 15, 13, 5, 9), timed: true }],
    ["2024-03-15T13:05:09.5", { start: utc(2024, 3, 15, 13, 5, 9) + 500, timed: true }],
    ["2024-03-15T13:05:09.123Z", { start: utc(2024, 3, 15, 13, 5, 9) + 123, timed: true }],
    ["2024-03-15T13:05+05:30", { start: utc(2024, 3, 15, 7, 35), timed: true }],
    ["2024-03-15T13:05-08:00", { start: utc(2024, 3, 15, 21, 5), timed: true }],
    ["2024-02-29", { start: utc(2024, 2, 29), timed: false }],
  ])("parses %s", (text, expected) => {
    expect(ev(`parseDate("${text}")`)).toMatchObject(expected);
  });

  it.each([
    "2024-02-30",
    "2023-02-29",
    "2024-13-01",
    "2024-00-10",
    "2024-03-15T25:00",
    "2024-03-15T10:61",
    "15/03/2024",
    "",
    "2024-3-5",
    "tomorrow",
    "2024-03-15T13",
  ])("rejects %s", (text) => {
    expect(ev(`parseDate("${text}")`)).toBeNull();
  });

  it("reads wall time in the context zone when there is no offset", () => {
    expect(start(zoned('parseDate("2024-03-15T13:05")', NY))).toBe(utc(2024, 3, 15, 17, 5));
    expect(start(zoned('parseDate("2024-03-15T13:05Z")', NY))).toBe(utc(2024, 3, 15, 13, 5));
  });
});

describe("clock", () => {
  it("reads now and today only from the injected clock", () => {
    expect(ev("now()")).toEqual({ kind: "date", start: NOW, timed: true });
    expect(ev("today()")).toEqual({ kind: "date", start: utc(2024, 3, 15), timed: false });
    expect(ev("today()", {}, { now: utc(2030, 1, 1) })).toMatchObject({ start: utc(2030, 1, 1) });
  });

  it.each([
    ["UTC", utc(2024, 3, 15, 23, 30), utc(2024, 3, 15)],
    [KOLKATA, utc(2024, 3, 15, 23, 30), utc(2024, 3, 16)],
    ["Pacific/Auckland", NOW, utc(2024, 3, 16)],
    ["America/Los_Angeles", NOW, utc(2024, 3, 15)],
    ["America/Los_Angeles", utc(2024, 3, 15, 5, 0), utc(2024, 3, 14)],
    [NY, utc(2024, 3, 10, 6, 59), utc(2024, 3, 10)],
  ])("today in %s at %i", (timeZone, now, expected) => {
    expect(ev("today()", {}, { timeZone, now })).toEqual({
      kind: "date",
      start: expected,
      timed: false,
    });
  });

  it("is deterministic for the same inputs", () => {
    const a = ev('dateAdd(now(), 3, "days")');
    expect(ev('dateAdd(now(), 3, "days")')).toEqual(a);
    expect(ev('dateAdd(now(), 3, "days")', {}, { now: NOW + 1 })).not.toEqual(a);
  });

  it("measures days until a date", () => {
    expect(ev('dateBetween(parseDate("2024-03-20"), today(), "days")')).toBe(5);
    expect(ev('dateBetween(parseDate("2024-03-10"), today(), "days")')).toBe(-5);
  });
});

describe("dateAdd and dateSubtract", () => {
  const add = (date: string, n: number, unit: string, timeZone = "UTC"): FormulaValue =>
    zoned(`dateAdd(parseDate("${date}"), ${n}, "${unit}")`, timeZone);

  it.each([
    ["2024-01-31", 1, "months", utc(2024, 2, 29)],
    ["2023-01-31", 1, "months", utc(2023, 2, 28)],
    ["2024-03-31", -1, "months", utc(2024, 2, 29)],
    ["2024-08-31", 1, "month", utc(2024, 9, 30)],
    ["2024-02-29", 1, "years", utc(2025, 2, 28)],
    ["2024-02-29", -1, "years", utc(2023, 2, 28)],
    ["2024-02-29", 4, "years", utc(2028, 2, 29)],
    ["2023-11-30", 1, "quarters", utc(2024, 2, 29)],
    ["2024-12-15", 2, "months", utc(2025, 2, 15)],
    ["2024-01-15", -2, "months", utc(2023, 11, 15)],
    ["2024-03-15", 2, "weeks", utc(2024, 3, 29)],
    ["2024-12-31", 1, "days", utc(2025, 1, 1)],
    ["2024-03-01", -1, "days", utc(2024, 2, 29)],
    ["2024-02-28", 1, "days", utc(2024, 2, 29)],
    ["2023-02-28", 1, "days", utc(2023, 3, 1)],
    ["2100-02-28", 1, "days", utc(2100, 3, 1)],
    ["2000-02-28", 1, "days", utc(2000, 2, 29)],
    ["2024-03-15", 1.9, "days", utc(2024, 3, 16)],
    ["2024-03-15", -1.9, "days", utc(2024, 3, 14)],
    ["2024-03-15", 0, "days", utc(2024, 3, 15)],
  ])("%s plus %d %s", (date, n, unit, expected) => {
    expect(add(date, n, unit)).toEqual({ kind: "date", start: expected, timed: false });
  });

  it("keeps a date-only result for day units and goes timed for hours and smaller", () => {
    expect(add("2024-03-15", 5, "hours")).toEqual({
      kind: "date",
      start: utc(2024, 3, 15, 5),
      timed: true,
    });
    expect(add("2024-03-15", 90, "minutes")).toMatchObject({
      start: utc(2024, 3, 15, 1, 30),
      timed: true,
    });
    expect(add("2024-03-15", 30, "seconds")).toMatchObject({
      start: utc(2024, 3, 15, 0, 0, 30),
      timed: true,
    });
    expect(add("2024-03-15", 1500, "milliseconds")).toMatchObject({
      start: utc(2024, 3, 15) + 1500,
      timed: true,
    });
  });

  it("brings a date-only value to midnight in the context zone before adding hours", () => {
    expect(add("2024-03-15", 5, "hours", NY)).toMatchObject({
      start: utc(2024, 3, 15, 9),
      timed: true,
    });
  });

  it("accepts singular and plural units, and gives empty for an unknown computed unit", () => {
    expect(add("2024-03-15", 1, "day")).toMatchObject({ start: utc(2024, 3, 16) });
    expect(
      ev('dateAdd(parseDate("2024-03-15"), 1, prop("Name"))', { row1: { t_name: "fortnights" } }),
    ).toBeNull();
    expect(ev('dateAdd(parseDate("2024-03-15"), prop("Count"), "days")')).toBeNull();
  });

  it("subtracts", () => {
    expect(ev('dateSubtract(parseDate("2024-03-31"), 1, "months")')).toMatchObject({
      start: utc(2024, 2, 29),
    });
    expect(ev('dateSubtract(parseDate("2024-03-15"), 36, "hours")')).toMatchObject({
      start: utc(2024, 3, 13, 12),
    });
  });

  it("shifts both ends of a range and keeps the zone", () => {
    expect(
      ev('dateAdd(dateRange(parseDate("2024-01-31"), parseDate("2024-02-10")), 1, "months")'),
    ).toEqual({
      kind: "date",
      start: utc(2024, 2, 29),
      end: utc(2024, 3, 10),
      timed: false,
    });
    const store: Store = { row1: { t_due: instant(utc(2024, 3, 15, 20), KOLKATA) } };
    expect(ev('dateAdd(prop("Due"), 1, "days")', store)).toMatchObject({
      zone: KOLKATA,
      start: utc(2024, 3, 16, 20),
    });
  });

  it("keeps wall time across daylight saving for day units and elapsed time for hours", () => {
    expect(zoned('dateAdd(parseDate("2024-03-09T12:00"), 1, "days")', NY)).toMatchObject({
      start: utc(2024, 3, 10, 16),
    });
    expect(zoned('dateAdd(parseDate("2024-03-09T12:00"), 24, "hours")', NY)).toMatchObject({
      start: utc(2024, 3, 10, 17),
    });
    expect(zoned('dateAdd(parseDate("2024-11-02T12:00"), 1, "days")', NY)).toMatchObject({
      start: utc(2024, 11, 3, 17),
    });
    expect(zoned('dateAdd(parseDate("2024-11-02T12:00"), 24, "hours")', NY)).toMatchObject({
      start: utc(2024, 11, 3, 16),
    });
    expect(zoned('dateAdd(parseDate("2024-03-09T02:30"), 1, "days")', NY)).toMatchObject({
      start: utc(2024, 3, 10, 7, 30),
    });
    expect(zoned('dateAdd(parseDate("2024-03-30T12:00"), 1, "days")', BERLIN)).toMatchObject({
      start: utc(2024, 3, 31, 10),
    });
    expect(zoned('dateAdd(parseDate("2024-01-31T12:00"), 1, "months")', NY)).toMatchObject({
      start: utc(2024, 2, 29, 17),
    });
    expect(zoned('dateAdd(parseDate("2024-03-10T01:30"), 1, "hours")', NY)).toMatchObject({
      start: utc(2024, 3, 10, 7, 30),
    });
  });

  it("gives empty beyond the representable range", () => {
    expect(ev('dateAdd(parseDate("2024-03-15"), 1000000000000, "years")')).toBeNull();
    expect(ev('dateAdd(parseDate("2024-03-15"), 1e30, "days")')).toBeNull();
  });
});

describe("dateBetween", () => {
  const between = (a: string, b: string, unit: string, timeZone = "UTC"): FormulaValue =>
    zoned(`dateBetween(parseDate("${a}"), parseDate("${b}"), "${unit}")`, timeZone);

  it.each([
    ["2024-03-15", "2024-03-10", "days", 5],
    ["2024-03-10", "2024-03-15", "days", -5],
    ["2024-03-15", "2024-03-15", "days", 0],
    ["2024-03-15", "2024-03-01", "weeks", 2],
    ["2024-03-15", "2024-01-31", "months", 1],
    ["2024-03-31", "2024-02-29", "months", 1],
    ["2024-03-28", "2024-02-29", "months", 0],
    ["2024-03-15", "2024-03-16", "months", 0],
    ["2023-12-15", "2024-03-15", "months", -3],
    ["2023-12-14", "2024-03-15", "months", -3],
    ["2023-12-16", "2024-03-15", "months", -2],
    ["2024-03-15", "2023-03-16", "years", 0],
    ["2024-03-16", "2023-03-16", "years", 1],
    ["2022-03-15", "2024-03-16", "years", -2],
    ["2024-09-15", "2024-03-15", "quarters", 2],
    ["2024-09-14", "2024-03-15", "quarters", 1],
    ["2024-03-15", "2024-03-14", "hours", 24],
    ["2024-03-15", "2024-03-14", "minutes", 1440],
    ["2024-03-15", "2024-03-14", "seconds", 86400],
    ["2024-03-15T10:30", "2024-03-15T10:00", "minutes", 30],
    ["2024-03-15T10:30", "2024-03-15T10:00", "hours", 0],
    ["2024-03-15T10:00", "2024-03-15T10:30", "minutes", -30],
    ["2024-03-15T10:00:01.500", "2024-03-15T10:00:00", "milliseconds", 1500],
    ["2024-03-15", "2024-03-15", "months", 0],
  ])("%s - %s in %s is %d", (a, b, unit, expected) => {
    expect(between(a, b, unit)).toBe(expected);
  });

  it("never returns negative zero", () => {
    expect(Object.is(between("2024-03-15", "2024-03-15", "days"), 0)).toBe(true);
    expect(Object.is(between("2023-03-16", "2024-03-15", "years"), 0)).toBe(true);
    expect(Object.is(between("2024-03-15T10:00", "2024-03-15T10:30", "hours"), 0)).toBe(true);
  });

  it("measures elapsed time across a daylight saving change", () => {
    expect(between("2024-03-10T12:00", "2024-03-09T12:00", "hours", NY)).toBe(23);
    expect(between("2024-03-10T12:00", "2024-03-09T12:00", "days", NY)).toBe(0);
    expect(between("2024-11-03T12:00", "2024-11-02T12:00", "hours", NY)).toBe(25);
    expect(between("2024-04-01T00:30", "2024-03-01T00:30", "months", BERLIN)).toBe(1);
    expect(between("2024-03-31T12:00", "2024-02-29T12:00", "months", NY)).toBe(1);
  });

  it("brings a date-only side to its midnight in the context zone when mixed", () => {
    const mixed = (timeZone: string): FormulaValue =>
      zoned(
        'dateBetween(parseDate("2024-03-15T00:00Z"), parseDate("2024-03-15"), "hours")',
        timeZone,
      );
    expect(mixed("UTC")).toBe(0);
    expect(mixed(NY)).toBe(-4);
    expect(mixed(KOLKATA)).toBe(5);
  });

  it("is empty for empty dates and unknown computed units", () => {
    expect(ev('dateBetween(prop("Due"), today(), "days")')).toBeNull();
    expect(
      ev('dateBetween(parseDate("2024-03-15"), parseDate("2024-03-10"), prop("Name"))', {
        row1: { t_name: "eons" },
      }),
    ).toBeNull();
  });
});

describe("ranges, timestamps and comparison", () => {
  it("builds ranges and takes their ends", () => {
    expect(ev('dateRange(parseDate("2024-03-15"), parseDate("2024-03-17"))')).toEqual({
      kind: "date",
      start: utc(2024, 3, 15),
      end: utc(2024, 3, 17),
      timed: false,
    });
    expect(ev('dateRange(parseDate("2024-03-17"), parseDate("2024-03-15"))')).toBeNull();
    expect(ev('dateRange(parseDate("2024-03-15"), parseDate("2024-03-15"))')).toMatchObject({
      end: utc(2024, 3, 15),
    });
    expect(
      ev('dateRange(parseDate("2024-03-15T08:00Z"), parseDate("2024-03-15T09:30Z"))'),
    ).toMatchObject({
      timed: true,
      end: utc(2024, 3, 15, 9, 30),
    });
    expect(
      zoned('dateRange(parseDate("2024-03-15"), parseDate("2024-03-15T10:00Z"))', NY),
    ).toMatchObject({
      timed: true,
      start: utc(2024, 3, 15, 4),
    });
    expect(ev('dateStart(dateRange(parseDate("2024-03-15"), parseDate("2024-03-17")))')).toEqual({
      kind: "date",
      start: utc(2024, 3, 15),
      timed: false,
    });
    expect(
      ev('dateEnd(dateRange(parseDate("2024-03-15"), parseDate("2024-03-17")))'),
    ).toMatchObject({ start: utc(2024, 3, 17) });
    expect(ev('dateEnd(parseDate("2024-03-15"))')).toMatchObject({ start: utc(2024, 3, 15) });
    expect(ev('dateEnd(prop("Due"))')).toBeNull();
  });

  it("converts to and from timestamps", () => {
    expect(ev('timestamp(parseDate("1970-01-02"))')).toBe(86_400_000);
    expect(zoned('timestamp(parseDate("1970-01-02"))', NY)).toBe(86_400_000 + 5 * 3_600_000);
    expect(ev('timestamp(parseDate("2024-03-15T00:00:00.250Z"))')).toBe(utc(2024, 3, 15) + 250);
    expect(ev("fromTimestamp(0)")).toEqual({ kind: "date", start: 0, timed: true });
    expect(ev("format(fromTimestamp(0))")).toBe("January 1, 1970 12:00 AM");
    expect(ev("fromTimestamp(1e20)")).toBeNull();
    expect(ev('fromTimestamp(prop("Count"))')).toBeNull();
    expect(ev("timestamp(fromTimestamp(1700000000000))")).toBe(1_700_000_000_000);
  });

  it("compares a date-only value with a timed one in the context zone", () => {
    const lt = 'parseDate("2024-03-15") < parseDate("2024-03-15T00:30Z")';
    expect(ev(lt)).toBe(true);
    expect(zoned(lt, NY)).toBe(false);
    const eq = 'parseDate("2024-03-15") == parseDate("2024-03-15T00:00Z")';
    expect(ev(eq)).toBe(true);
    expect(zoned(eq, NY)).toBe(false);
    expect(zoned('parseDate("2024-03-15") == parseDate("2024-03-15")', NY)).toBe(true);
    expect(zoned('parseDate("2024-03-15T04:00Z") == parseDate("2024-03-15")', NY)).toBe(true);
  });

  it("compares ranges by both ends", () => {
    const r = 'dateRange(parseDate("2024-03-15"), parseDate("2024-03-17"))';
    expect(ev(`${r} == ${r}`)).toBe(true);
    expect(ev(`${r} == parseDate("2024-03-15")`)).toBe(false);
    expect(ev(`${r} == dateRange(parseDate("2024-03-15"), parseDate("2024-03-18"))`)).toBe(false);
  });
});
