import type { ScheduledTask } from "@t2code/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { onceAtFromInput, onceInputValue, onceTaskStatus } from "./scheduledTaskOnce.logic";

afterEach(() => vi.unstubAllEnvs());

const AT = "2026-09-15T08:00:00.000Z";
const NOW = new Date("2026-09-14T08:00:00.000Z");

const task = (override: Partial<ScheduledTask>): ScheduledTask =>
  ({
    schedule: { type: "once", at: AT },
    enabled: true,
    nextRunAt: AT,
    lastRunAt: null,
    lastRunStatus: "never",
    ...override,
  }) as ScheduledTask;

describe("once editor value", () => {
  it("round-trips an instant through the device's local time zone", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    expect(onceInputValue(AT)).toBe("2026-09-15T13:30");
    expect(onceAtFromInput("2026-09-15T13:30")).toBe(AT);
  });

  it("rejects an incomplete or impossible value", () => {
    expect(onceAtFromInput("")).toBeNull();
    expect(onceAtFromInput("2026-09-15")).toBeNull();
    expect(onceAtFromInput("2026-02-30T10:00")).toBeNull();
  });

  it("accepts a past time so the server can decide", () => {
    expect(onceAtFromInput("2001-01-01T10:00")).not.toBeNull();
  });
});

describe("onceTaskStatus", () => {
  it("describes the lifecycle of a one-time task", () => {
    expect(onceTaskStatus(task({}), NOW)).toMatch(/^Sends /);
    expect(onceTaskStatus(task({ enabled: false, nextRunAt: null }), NOW)).toMatch(/^Paused/);
    expect(onceTaskStatus(task({ lastRunStatus: "running" }), NOW)).toBe("Sending now");
    expect(
      onceTaskStatus(task({ lastRunStatus: "succeeded", lastRunAt: AT, nextRunAt: null }), NOW),
    ).toMatch(/^Sent /);
    expect(
      onceTaskStatus(task({ lastRunStatus: "failed", lastRunAt: AT, nextRunAt: null }), NOW),
    ).toMatch(/^Could not send/);
  });

  it("shows a re-armed sent task as pending again", () => {
    expect(
      onceTaskStatus(
        task({ lastRunStatus: "succeeded", lastRunAt: "2026-09-13T08:00:00.000Z", nextRunAt: AT }),
        NOW,
      ),
    ).toMatch(/^Sends /);
    expect(
      onceTaskStatus(
        task({ lastRunStatus: "failed", lastRunAt: "2026-09-13T08:00:00.000Z", nextRunAt: AT }),
        NOW,
      ),
    ).toMatch(/^Sends /);
  });

  it("flags a message that went out well after its time", () => {
    expect(
      onceTaskStatus(
        task({
          lastRunStatus: "succeeded",
          lastRunAt: "2026-09-15T11:00:00.000Z",
          nextRunAt: null,
        }),
        NOW,
      ),
    ).toMatch(/^Sent late/);
  });
});
