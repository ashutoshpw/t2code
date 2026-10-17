import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });

  it.each([
    ["9:00", "09:00"],
    ["09:00", "9:00"],
    ["0:30", "00:30"],
  ])("treats %s and %s as the same fixed-time schedule", (before, after) => {
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: before },
        { type: "fixed_time", timeOfDay: after },
      ),
    ).toBe(true);
  });

  it("runs a one-time schedule only while its instant is still ahead", () => {
    const at = "2026-07-01T16:00:00.000Z";
    const next = nextScheduledRunAt(
      { type: "once", at },
      DateTime.makeUnsafe("2026-07-01T15:59:59Z"),
    );
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe(at);
    expect(nextScheduledRunAt({ type: "once", at }, DateTime.makeUnsafe(at))).toBeNull();
    expect(
      nextScheduledRunAt({ type: "once", at }, DateTime.makeUnsafe("2026-07-02T00:00:00Z")),
    ).toBeNull();
  });

  it("never treats an overdue one-time run as missed, and compares it by instant", () => {
    const schedule = { type: "once", at: "2026-07-01T16:00:00.000Z" } as const;
    expect(
      isMissedFixedTimeRun(
        schedule,
        DateTime.makeUnsafe(schedule.at),
        DateTime.makeUnsafe("2026-07-03T00:00:00Z"),
      ),
    ).toBe(false);
    expect(isSameSchedule(schedule, { type: "once", at: "2026-07-01T16:00:00Z" })).toBe(true);
    expect(isSameSchedule(schedule, { type: "once", at: "2026-07-01T17:00:00.000Z" })).toBe(false);
    expect(isSameSchedule(schedule, { type: "interval", everyMs: 60_000 })).toBe(false);
  });
});
