import { describe, expect, it } from "vite-plus/test";

import { calendarRange, stepAnchor, weekColumns } from "./calendarRange";

describe("calendarRange", () => {
  it("covers a month in whole weeks for both week starts", () => {
    // November 2026 starts on a Sunday and ends on a Monday.
    const sunday = calendarRange("2026-11-15", "month", "sunday");
    expect([sunday.firstDay, sunday.lastDay]).toEqual(["2026-11-01", "2026-12-05"]);
    expect(sunday.weeks).toHaveLength(5);
    const monday = calendarRange("2026-11-15", "month", "monday");
    expect([monday.firstDay, monday.lastDay]).toEqual(["2026-10-26", "2026-12-06"]);
    expect(monday.weeks).toHaveLength(6);
  });

  it("handles a month that fits exactly four weeks and year ends", () => {
    const february = calendarRange("2026-02-10", "month", "sunday");
    expect([february.firstDay, february.lastDay, february.weeks.length]).toEqual([
      "2026-02-01",
      "2026-02-28",
      4,
    ]);
    const december = calendarRange("2026-12-31", "month", "monday");
    expect([december.firstDay, december.lastDay]).toEqual(["2026-11-30", "2027-01-03"]);
  });

  it("is one week in week mode", () => {
    expect(calendarRange("2026-11-11", "week", "monday")).toEqual({
      firstDay: "2026-11-09",
      lastDay: "2026-11-15",
      weeks: ["2026-11-09"],
    });
  });

  it("drops weekend columns without dropping them from the range", () => {
    expect(weekColumns("2026-11-08", false)).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
    ]);
    expect(weekColumns("2026-11-08", true)).toHaveLength(7);
    expect(calendarRange("2026-11-15", "month", "sunday").lastDay).toBe("2026-12-05");
  });

  it("steps by a month or a week", () => {
    expect(stepAnchor("2026-01-31", "month", 1)).toBe("2026-02-01");
    expect(stepAnchor("2026-01-15", "month", -1)).toBe("2025-12-01");
    expect(stepAnchor("2026-11-11", "week", -1)).toBe("2026-11-04");
  });
});
