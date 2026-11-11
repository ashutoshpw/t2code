import { describe, expect, it } from "vite-plus/test";

import { barSpan, barWrites } from "./timelineDrag";

const DAY = 1440;
const serial = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 60_000;

describe("barSpan", () => {
  it("draws a date-only range through the end of its last day", () => {
    expect(barSpan({ start: "2026-03-10", end: "2026-03-12" }, undefined, false, "UTC")).toEqual({
      start: serial("2026-03-10"),
      end: serial("2026-03-12") + DAY,
      timed: false,
    });
  });

  it("gives a single day one day and a single time one hour", () => {
    expect(barSpan({ start: "2026-03-10" }, undefined, false, "UTC")?.end).toBe(
      serial("2026-03-11"),
    );
    const timed = barSpan(
      { start: "2026-03-10T09:00:00", timeZone: "UTC" },
      undefined,
      false,
      "UTC",
    )!;
    expect(timed.end - timed.start).toBe(60);
  });

  it("takes the end from a separate property and ignores an end before the start", () => {
    expect(barSpan({ start: "2026-03-10" }, { start: "2026-03-14" }, true, "UTC")?.end).toBe(
      serial("2026-03-14") + DAY,
    );
    expect(barSpan({ start: "2026-03-10" }, { start: "2026-03-01" }, true, "UTC")?.end).toBe(
      serial("2026-03-11"),
    );
    expect(barSpan({ start: "2026-03-10" }, undefined, true, "UTC")?.end).toBe(
      serial("2026-03-11"),
    );
  });

  it("has no bar without a start", () => {
    expect(barSpan(undefined, { start: "2026-03-14" }, true, "UTC")).toBeNull();
  });
});

describe("barWrites", () => {
  const base = { zone: "UTC", endValue: undefined };

  it("writes one cell for one property, moving or resizing", () => {
    const startValue = { start: "2026-03-10", end: "2026-03-12" };
    expect(
      barWrites({ ...base, mode: "move", deltaMinutes: 2 * DAY, startValue, separateEnd: false }),
    ).toEqual([{ side: "start", value: { start: "2026-03-12", end: "2026-03-14" } }]);
    expect(
      barWrites({ ...base, mode: "end", deltaMinutes: DAY, startValue, separateEnd: false }),
    ).toEqual([{ side: "start", value: { start: "2026-03-10", end: "2026-03-13" } }]);
    expect(
      barWrites({ ...base, mode: "start", deltaMinutes: -DAY, startValue, separateEnd: false }),
    ).toEqual([{ side: "start", value: { start: "2026-03-09", end: "2026-03-12" } }]);
  });

  it("keeps time of day and zone at quarter-hour steps", () => {
    expect(
      barWrites({
        ...base,
        mode: "move",
        deltaMinutes: 15,
        startValue: {
          start: "2026-03-10T09:00:00",
          end: "2026-03-10T10:00:00",
          timeZone: "Asia/Tokyo",
        },
        separateEnd: false,
      }),
    ).toEqual([
      {
        side: "start",
        value: { start: "2026-03-10T09:15:00", end: "2026-03-10T10:15:00", timeZone: "Asia/Tokyo" },
      },
    ]);
  });

  it("writes both cells of two properties together on a move and one on a resize", () => {
    const input = {
      deltaMinutes: DAY,
      startValue: { start: "2026-03-10" },
      endValue: { start: "2026-03-12" },
      separateEnd: true,
      zone: "UTC",
    } as const;
    expect(barWrites({ ...input, mode: "move" })).toEqual([
      { side: "start", value: { start: "2026-03-11" } },
      { side: "end", value: { start: "2026-03-13" } },
    ]);
    expect(barWrites({ ...input, mode: "end" })).toEqual([
      { side: "end", value: { start: "2026-03-13" } },
    ]);
    expect(barWrites({ ...input, mode: "start" })).toEqual([
      { side: "start", value: { start: "2026-03-11" } },
    ]);
  });

  it("stops a start dragged past the end and an end dragged before the start", () => {
    const input = {
      startValue: { start: "2026-03-10" },
      endValue: { start: "2026-03-12" },
      separateEnd: true,
      zone: "UTC",
    } as const;
    expect(barWrites({ ...input, mode: "start", deltaMinutes: 5 * DAY })).toEqual([
      { side: "start", value: { start: "2026-03-12" } },
    ]);
    expect(barWrites({ ...input, mode: "end", deltaMinutes: -5 * DAY })).toEqual([
      { side: "end", value: { start: "2026-03-10" } },
    ]);
    expect(barWrites({ ...input, mode: "start", deltaMinutes: -DAY })).toEqual([
      { side: "start", value: { start: "2026-03-09" } },
    ]);
  });

  it("starts an empty end property at the start day, and writes nothing for no movement", () => {
    expect(
      barWrites({
        mode: "end",
        deltaMinutes: 2 * DAY,
        startValue: { start: "2026-03-10" },
        endValue: undefined,
        separateEnd: true,
        zone: "UTC",
      }),
    ).toEqual([{ side: "end", value: { start: "2026-03-12" } }]);
    expect(
      barWrites({
        mode: "move",
        deltaMinutes: 0,
        startValue: { start: "2026-03-10" },
        endValue: undefined,
        separateEnd: false,
        zone: "UTC",
      }),
    ).toEqual([]);
  });
});
