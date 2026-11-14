import { describe, expect, it } from "vite-plus/test";

import {
  PX_PER_DAY,
  SPAN_DAYS,
  ZOOMS,
  dayToX,
  deltaToMinutes,
  makeScale,
  rowWindow,
  snapMinutes,
  ticks,
  xToDay,
  xToSerial,
  serialToX,
} from "./timelineScale";

describe("scale", () => {
  it("covers the documented span at the documented density for every zoom", () => {
    for (const zoom of ZOOMS) {
      const scale = makeScale(zoom, "2026-06-15");
      expect(scale.width).toBe(Math.round(SPAN_DAYS[zoom] * PX_PER_DAY[zoom]));
      expect(xToDay(scale, dayToX(scale, "2026-06-15"))).toBe("2026-06-15");
    }
    expect(PX_PER_DAY.hours).toBe(960);
    expect(PX_PER_DAY.year).toBe(1.5);
  });

  it("round-trips serials and puts the anchor in the middle", () => {
    const scale = makeScale("day", "2026-06-15");
    const serial = Date.UTC(2026, 5, 15, 9, 30) / 60_000;
    expect(xToSerial(scale, serialToX(scale, serial))).toBe(serial);
    expect(dayToX(scale, "2026-06-15")).toBe(60 * 120);
    expect(dayToX(scale, "2026-06-16") - dayToX(scale, "2026-06-15")).toBe(120);
  });

  it("snaps to quarter hours at hour zoom for timed values and to days otherwise", () => {
    expect(snapMinutes("hours", true)).toBe(15);
    expect(snapMinutes("hours", false)).toBe(1440);
    expect(snapMinutes("month", true)).toBe(1440);
    const hours = makeScale("hours", "2026-06-15");
    // 960 px per day: 10 px is 15 minutes.
    expect(deltaToMinutes(hours, 11, 15)).toBe(15);
    expect(deltaToMinutes(hours, 4, 15)).toBe(0);
    const month = makeScale("month", "2026-06-15");
    expect(deltaToMinutes(month, 26, 1440)).toBe(3 * 1440);
    expect(deltaToMinutes(month, -14, 1440)).toBe(-1440);
  });
});

describe("ticks", () => {
  it("gives day and month tiers that line up at month ends", () => {
    const scale = makeScale("day", "2026-02-10");
    const from = dayToX(scale, "2026-02-26");
    const bottom = ticks(scale, "bottom", from, dayToX(scale, "2026-03-03"));
    expect(bottom.map((tick) => tick.label)).toEqual(["26", "27", "28", "1", "2", "3"]);
    const top = ticks(scale, "top", from, dayToX(scale, "2026-03-03"));
    expect(top).toHaveLength(2);
    expect(top[0]!.x + top[0]!.width).toBeCloseTo(top[1]!.x);
    expect(top[0]!.width).toBeCloseTo(28 * 120);
  });

  it("builds hour ticks inside the visible range only", () => {
    const scale = makeScale("hours", "2026-06-15");
    const x = dayToX(scale, "2026-06-15");
    const bottom = ticks(scale, "bottom", x, x + 4 * 40);
    expect(bottom.map((tick) => tick.label)).toEqual(["00", "01", "02", "03", "04"]);
  });

  it("uses weeks starting on Monday, fixed fortnights, quarters and decades", () => {
    const week = makeScale("week", "2026-06-15");
    const weeks = ticks(week, "bottom", dayToX(week, "2026-06-10"), dayToX(week, "2026-06-24"));
    expect(weeks.map((tick) => tick.width)).toEqual([280, 280, 280]);
    expect(xToDay(week, weeks[0]!.x)).toBe("2026-06-08");
    const biweek = makeScale("biweek", "2026-06-15");
    const fortnights = ticks(
      biweek,
      "bottom",
      dayToX(biweek, "2026-06-01"),
      dayToX(biweek, "2026-07-30"),
    );
    const days = fortnights.map((tick) => xToDay(biweek, tick.x));
    expect(days.slice(1).map((day, i) => Date.parse(day) - Date.parse(days[i]!))).toEqual(
      days.slice(1).map(() => 14 * 86_400_000),
    );
    const quarter = makeScale("quarter", "2026-06-15");
    expect(
      ticks(quarter, "bottom", dayToX(quarter, "2026-01-01"), dayToX(quarter, "2026-12-31")).map(
        (t) => t.label,
      ),
    ).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    const year = makeScale("year", "2026-06-15");
    expect(
      ticks(year, "top", dayToX(year, "2020-01-01"), dayToX(year, "2031-01-01")).map(
        (t) => t.label,
      ),
    ).toEqual(["2020s", "2030s"]);
  });
});

describe("rowWindow", () => {
  it("windows fixed rows with overscan and clamps to the count", () => {
    expect(rowWindow(1000, 0, 360)).toEqual({ first: 0, last: 16 });
    expect(rowWindow(1000, 3600, 360)).toEqual({ first: 94, last: 116 });
    expect(rowWindow(10, 3600, 360)).toEqual({ first: 10, last: 10 });
    expect(rowWindow(0, 0, 360)).toEqual({ first: 0, last: 0 });
  });
});
