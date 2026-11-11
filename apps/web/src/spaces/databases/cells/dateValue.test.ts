import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_DATE_DRAFT,
  buildDateValue,
  dateToDay,
  dayToDate,
  parseDateValue,
  parseTypedDay,
} from "./dateValue";

describe("parseDateValue and buildDateValue", () => {
  it("round trips a date only value", () => {
    const draft = parseDateValue({ start: "2026-01-02" });
    expect(draft).toMatchObject({ startDate: "2026-01-02", hasEnd: false, hasTime: false });
    expect(buildDateValue(draft, "Europe/Berlin")).toEqual({ start: "2026-01-02" });
  });

  it("round trips a range with times and stamps the viewer zone", () => {
    const value = { start: "2026-01-02T09:30:00", end: "2026-01-03T17:00:00", timeZone: "UTC" };
    const draft = parseDateValue(value);
    expect(draft).toMatchObject({
      startTime: "09:30",
      endDate: "2026-01-03",
      endTime: "17:00",
      hasTime: true,
    });
    expect(buildDateValue(draft, "Asia/Tokyo")).toEqual({ ...value, timeZone: "Asia/Tokyo" });
  });

  it("defaults a missing time to midnight and raises an end before the start", () => {
    expect(
      buildDateValue({ ...EMPTY_DATE_DRAFT, startDate: "2026-01-02", hasTime: true }, "UTC"),
    ).toEqual({ start: "2026-01-02T00:00:00", timeZone: "UTC" });
    expect(
      buildDateValue(
        { ...EMPTY_DATE_DRAFT, startDate: "2026-01-05", endDate: "2026-01-01", hasEnd: true },
        "UTC",
      ),
    ).toEqual({ start: "2026-01-05", end: "2026-01-05" });
  });

  it("has no value without a start day", () => {
    expect(buildDateValue(EMPTY_DATE_DRAFT, "UTC")).toBeNull();
    expect(parseDateValue(null)).toBe(EMPTY_DATE_DRAFT);
  });
});

describe("typed days", () => {
  it("accepts ISO and US forms of real days only", () => {
    expect(parseTypedDay("2026-1-5")).toBe("2026-01-05");
    expect(parseTypedDay("3/4/2026")).toBe("2026-03-04");
    expect(parseTypedDay("2026-02-29")).toBeNull();
    expect(parseTypedDay("tomorrow")).toBeNull();
  });

  it("converts to a local date and back without a zone shift", () => {
    expect(dateToDay(dayToDate("2026-12-31")!)).toBe("2026-12-31");
    expect(dayToDate("")).toBeUndefined();
  });
});
