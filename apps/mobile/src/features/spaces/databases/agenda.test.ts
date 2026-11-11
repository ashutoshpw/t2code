import { describe, expect, it } from "vite-plus/test";

import { row } from "./databaseFixtures.test-support";
import {
  agendaSections,
  dayLabel,
  monthBounds,
  monthLabel,
  monthOfNow,
  rangeLabel,
  stepMonth,
} from "./agenda";

const month = "2026-11-01";
const zone = "UTC";
const date = (start: string, end?: string) => ({ start, ...(end === undefined ? {} : { end }) });

describe("agenda", () => {
  it("steps and bounds months, including a year change and a leap February", () => {
    expect(stepMonth("2026-12-01", 1)).toBe("2027-01-01");
    expect(stepMonth("2026-01-01", -1)).toBe("2025-12-01");
    expect(monthBounds("2028-02-01")).toEqual({ firstDay: "2028-02-01", lastDay: "2028-02-29" });
    expect(monthLabel("2026-11-01")).toBe("November 2026");
    expect(dayLabel("2026-11-11")).toBe("Wed, Nov 11");
  });

  it("finds the month of a moment in the viewer's zone", () => {
    const instant = Date.parse("2026-11-30T23:30:00Z");
    expect(monthOfNow(instant, "UTC")).toBe("2026-11-01");
    expect(monthOfNow(instant, "Asia/Tokyo")).toBe("2026-12-01");
  });

  it("groups rows by day, parks an item from an earlier month under the first day and drops the rest", () => {
    const rows = [
      row("before", "Before", { due: date("2026-10-31") }),
      row("spans", "Spans", { due: date("2026-10-28", "2026-11-02") }),
      row("mid", "Mid", { due: date("2026-11-05") }),
      row("mid2", "Mid 2", { due: date("2026-11-05") }),
      row("last", "Last", { due: date("2026-11-30") }),
      row("after", "After", { due: date("2026-12-01") }),
      row("none", "None", {}),
    ];
    const sections = agendaSections(rows, "due", null, month, zone);
    expect(sections.map((section) => section.day)).toEqual([
      "2026-11-01",
      "2026-11-05",
      "2026-11-30",
    ]);
    expect(sections[0]?.items.map((item) => item.row.page.id)).toEqual(["spans"]);
    expect(rangeLabel(sections[0]!.items[0]!)).toBe("Wed, Oct 28 → Mon, Nov 2");
    expect(sections[1]?.items.map((item) => item.row.page.id)).toEqual(["mid", "mid2"]);
    expect(rangeLabel(sections[1]!.items[0]!)).toBeNull();
  });

  it("places a timeline row by its start property and ends it at the end property", () => {
    const rows = [
      row("a", "A", { start: date("2026-11-03"), end: date("2026-11-09") }),
      row("b", "B", { start: date("2026-11-10"), end: date("2026-11-04") }),
    ];
    const [first, second] = agendaSections(rows, "start", "end", month, zone).flatMap(
      (section) => section.items,
    );
    expect(first).toMatchObject({ startDay: "2026-11-03", endDay: "2026-11-09" });
    // An end before the start is ignored.
    expect(second).toMatchObject({ startDay: "2026-11-10", endDay: "2026-11-10" });
  });

  it("reads a timed date in the viewer's zone and a formula's wrapped date", () => {
    const rows = [
      row("late", "Late", { due: { start: "2026-11-05T23:30:00Z" } }),
      row("calc", "Calc", { due: { type: "date", value: { start: "2026-11-07" } } }),
    ];
    expect(
      agendaSections(rows, "due", null, month, "Asia/Tokyo").map((section) => section.day),
    ).toEqual(["2026-11-06", "2026-11-07"]);
  });
});
