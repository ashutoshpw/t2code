// @effect-diagnostics globalDate:off -- Tests exercise local calendar input and elapsed time.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  defaultSendLaterDate,
  formatSendLaterLabel,
  resolveSendLater,
  SEND_LATER_ERROR_MESSAGES,
} from "./sendLater.ts";

const now = new Date(2026, 8, 14, 14, 30, 20);

afterEach(() => vi.unstubAllEnvs());

describe("resolveSendLater", () => {
  it("converts local date and time to an absolute UTC instant", () => {
    expect(resolveSendLater({ date: "2026-09-15", time: "09:15" }, now)).toEqual({
      ok: true,
      at: new Date(2026, 8, 15, 9, 15).toISOString(),
    });
  });

  it("interprets the input in the device zone, not UTC", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    expect(
      resolveSendLater({ date: "2026-09-15", time: "09:00" }, new Date("2026-09-14T00:00:00Z")),
    ).toEqual({ ok: true, at: "2026-09-15T03:30:00.000Z" });
  });

  it("accepts the next minute but rejects the current minute and anything earlier", () => {
    expect(resolveSendLater({ date: "2026-09-14", time: "14:31" }, now).ok).toBe(true);
    expect(resolveSendLater({ date: "2026-09-14", time: "14:30" }, now)).toEqual({
      ok: false,
      reason: "past",
    });
    expect(resolveSendLater({ date: "2026-09-13", time: "23:59" }, now)).toEqual({
      ok: false,
      reason: "past",
    });
  });

  it.each([
    ["2027-02-29", "09:00"],
    ["2026-13-01", "09:00"],
    ["2026-09-15", "24:00"],
    ["2026-09-15", "09:60"],
    ["", "09:00"],
    ["2026-09-15", ""],
  ])("rejects invalid input %s %s", (date, time) => {
    expect(resolveSendLater({ date, time }, now)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a nonexistent local time at the spring DST transition", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(
      resolveSendLater({ date: "2027-03-14", time: "02:30" }, new Date("2027-03-01T00:00:00Z")),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("has a message for every rejection reason", () => {
    expect(SEND_LATER_ERROR_MESSAGES.past).not.toBe(SEND_LATER_ERROR_MESSAGES.invalid);
  });
});

describe("defaultSendLaterDate", () => {
  it("suggests the next top of the hour", () => {
    expect(defaultSendLaterDate(now)).toEqual(new Date(2026, 8, 14, 15, 0, 0));
    expect(defaultSendLaterDate(new Date(2026, 8, 14, 23, 59, 59))).toEqual(
      new Date(2026, 8, 15, 0, 0, 0),
    );
  });
});

describe("formatSendLaterLabel", () => {
  it("shows the zone and omits the day for a same-day send", () => {
    const label = formatSendLaterLabel(
      "2026-09-14T14:00:00.000Z",
      new Date("2026-09-14T08:00:00Z"),
      "UTC",
    );
    expect(label).toContain("UTC");
    expect(label).not.toMatch(/Sep/);
  });

  it("includes a date for sends beyond a week", () => {
    const label = formatSendLaterLabel(
      "2026-10-14T14:00:00.000Z",
      new Date("2026-09-14T08:00:00Z"),
      "UTC",
    );
    expect(label).toMatch(/Oct/);
  });

  it("falls back to the raw value for an unparseable instant", () => {
    expect(formatSendLaterLabel("nope", now)).toBe("nope");
  });
});
