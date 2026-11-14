import type { SpacePropertyId } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import {
  addDays,
  addMonths,
  isoDay,
  moveDateValue,
  overlapFilter,
  resizeDateValue,
  rowDaySpan,
  shiftDateValue,
  startOfWeek,
  weekdayOf,
} from "./dateRange.ts";

const prop = "p1" as SpacePropertyId;

describe("day arithmetic", () => {
  it("crosses month, year and leap-day boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2024-02-28", 2)).toBe("2024-03-01");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-01");
    expect(addMonths("2026-01-15", -2)).toBe("2025-11-01");
  });

  it("keeps years below 100 as written", () => {
    expect(addDays("0099-01-01", 1)).toBe("0099-01-02");
    expect(weekdayOf("0099-01-01")).toBe(weekdayOf("0099-01-08"));
  });

  it("finds the week start for both conventions", () => {
    expect(weekdayOf("2026-11-11")).toBe(3);
    expect(startOfWeek("2026-11-11", "sunday")).toBe("2026-11-08");
    expect(startOfWeek("2026-11-11", "monday")).toBe("2026-11-09");
    expect(startOfWeek("2026-11-08", "monday")).toBe("2026-11-02");
    expect(startOfWeek("2026-11-08", "sunday")).toBe("2026-11-08");
  });

  it("gives the calendar day of an instant in the viewer's zone", () => {
    const instant = Date.parse("2026-03-10T02:30:00Z");
    expect(isoDay(instant, "UTC")).toBe("2026-03-10");
    expect(isoDay(instant, "America/Los_Angeles")).toBe("2026-03-09");
    expect(isoDay(instant, "Asia/Kolkata")).toBe("2026-03-10");
  });
});

describe("rowDaySpan", () => {
  it("keeps date-only values floating whatever the zone", () => {
    expect(rowDaySpan({ start: "2026-03-10" }, "Pacific/Auckland")).toEqual({
      startDay: "2026-03-10",
      endDay: "2026-03-10",
    });
    expect(rowDaySpan({ start: "2026-03-10", end: "2026-03-12" }, "America/Los_Angeles")).toEqual({
      startDay: "2026-03-10",
      endDay: "2026-03-12",
    });
  });

  it("puts a timed value at 23:30 behind UTC on its own day", () => {
    expect(rowDaySpan({ start: "2026-03-10T23:30:00Z" }, "America/Los_Angeles")).toEqual({
      startDay: "2026-03-10",
      endDay: "2026-03-10",
    });
    expect(rowDaySpan({ start: "2026-03-11T06:30:00Z" }, "America/Los_Angeles")?.startDay).toBe(
      "2026-03-10",
    );
  });

  it("reads wall times in the value's own zone and ignores a broken end", () => {
    expect(
      rowDaySpan({ start: "2026-03-10T23:30:00", timeZone: "Asia/Tokyo" }, "America/Los_Angeles"),
    ).toEqual({ startDay: "2026-03-10", endDay: "2026-03-10" });
    expect(rowDaySpan({ start: "2026-03-10", end: "2026-03-01" }, "UTC")?.endDay).toBe(
      "2026-03-10",
    );
  });

  it("reads created and edited times, and nothing from garbage", () => {
    expect(rowDaySpan("2026-03-10T02:30:00.000Z", "America/Los_Angeles")?.startDay).toBe(
      "2026-03-09",
    );
    expect(rowDaySpan({ start: "soon" }, "UTC")).toBeNull();
    expect(rowDaySpan(null, "UTC")).toBeNull();
  });
});

describe("shiftDateValue", () => {
  it("moves a date-only range and keeps its length", () => {
    expect(shiftDateValue({ start: "2026-02-27", end: "2026-03-02" }, 3)).toEqual({
      start: "2026-03-02",
      end: "2026-03-05",
    });
    expect(shiftDateValue({ start: "2026-03-10" }, -10)).toEqual({ start: "2026-02-28" });
  });

  it("keeps the time of day and the zone across a daylight-saving change", () => {
    // US clocks spring forward on 2026-03-08: 09:00 stays 09:00 on the wall.
    expect(
      shiftDateValue(
        { start: "2026-03-07T09:00:00", end: "2026-03-07T10:30:00", timeZone: "America/New_York" },
        2,
        "UTC",
      ),
    ).toEqual({
      start: "2026-03-09T09:00:00",
      end: "2026-03-09T10:30:00",
      timeZone: "America/New_York",
    });
  });

  it("normalizes an offset value to wall time in the viewer's zone", () => {
    expect(shiftDateValue({ start: "2026-03-10T23:30:00Z" }, 1, "America/Los_Angeles")).toEqual({
      start: "2026-03-11T16:30:00",
      timeZone: "America/Los_Angeles",
    });
  });

  it("returns null for a cell without a date", () => {
    expect(shiftDateValue(null, 1)).toBeNull();
  });
});

describe("resizeDateValue", () => {
  it("moves one edge and never makes the range negative", () => {
    const range = { start: "2026-03-10", end: "2026-03-12" };
    expect(resizeDateValue(range, "end", 2)).toEqual({ start: "2026-03-10", end: "2026-03-14" });
    expect(resizeDateValue(range, "start", -1)).toEqual({ start: "2026-03-09", end: "2026-03-12" });
    expect(resizeDateValue(range, "end", -5)).toEqual({ start: "2026-03-10" });
    expect(resizeDateValue(range, "start", 5)).toEqual({ start: "2026-03-12" });
  });

  it("gives a single day an end when its end edge moves", () => {
    expect(resizeDateValue({ start: "2026-03-10" }, "end", 2)).toEqual({
      start: "2026-03-10",
      end: "2026-03-12",
    });
  });
});

describe("moveDateValue", () => {
  it("snaps date-only moves to whole days and timed moves to minutes", () => {
    expect(
      moveDateValue({ start: "2026-03-10" }, { startMinutes: 700, endMinutes: 700 }, "UTC"),
    ).toEqual({
      start: "2026-03-10",
    });
    expect(
      moveDateValue(
        { start: "2026-03-10T09:00:00", timeZone: "UTC" },
        { startMinutes: 45, endMinutes: 45 },
        "UTC",
      ),
    ).toEqual({ start: "2026-03-10T09:45:00", timeZone: "UTC" });
  });
});

describe("overlapFilter", () => {
  it("compares start and end parts of a date property", () => {
    expect(overlapFilter(prop, "date", "2026-03-01", "2026-04-04")).toEqual({
      and: [
        { property: prop, operator: "on_or_before", value: "2026-04-04", part: "start" },
        { property: prop, operator: "on_or_after", value: "2026-03-01", part: "end" },
      ],
    });
  });

  it("leaves the part out for created and edited times", () => {
    expect(JSON.stringify(overlapFilter(prop, "created_time", "a", "b"))).not.toContain("part");
  });
});

describe("computed date cells", () => {
  it("reads the date a formula or rollup wraps", () => {
    expect(
      rowDaySpan({ type: "date", value: { start: "2026-03-10", end: "2026-03-12" } }, "UTC"),
    ).toEqual({
      startDay: "2026-03-10",
      endDay: "2026-03-12",
    });
    expect(rowDaySpan({ type: "date" }, "UTC")).toBeNull();
    expect(rowDaySpan({ type: "number", value: 3 }, "UTC")).toBeNull();
  });
});
