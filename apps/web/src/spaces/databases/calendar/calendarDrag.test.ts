import { describe, expect, it } from "vite-plus/test";

import { dayDelta, dropValue } from "./calendarDrag";

describe("dropValue", () => {
  it("moves a single day by the distance between the grabbed and the dropped day", () => {
    expect(dropValue({ start: "2026-11-10" }, "move", "2026-11-10", "2026-11-14", "UTC")).toEqual({
      start: "2026-11-14",
    });
  });

  it("keeps a range's length when a middle day is grabbed", () => {
    expect(
      dropValue(
        { start: "2026-11-09", end: "2026-11-11" },
        "move",
        "2026-11-10",
        "2026-11-17",
        "UTC",
      ),
    ).toEqual({ start: "2026-11-16", end: "2026-11-18" });
  });

  it("keeps time and zone, and crosses month ends", () => {
    expect(
      dropValue(
        { start: "2026-01-31T23:30:00", timeZone: "America/Los_Angeles" },
        "move",
        "2026-01-31",
        "2026-02-02",
        "UTC",
      ),
    ).toEqual({ start: "2026-02-02T23:30:00", timeZone: "America/Los_Angeles" });
  });

  it("resizes one edge and never past the other", () => {
    const range = { start: "2026-11-09", end: "2026-11-11" };
    expect(dropValue(range, "end", "2026-11-11", "2026-11-13", "UTC")).toEqual({
      start: "2026-11-09",
      end: "2026-11-13",
    });
    expect(dropValue(range, "start", "2026-11-09", "2026-11-20", "UTC")).toEqual({
      start: "2026-11-11",
    });
  });

  it("returns null when dropped where it was", () => {
    expect(
      dropValue({ start: "2026-11-10" }, "move", "2026-11-10", "2026-11-10", "UTC"),
    ).toBeNull();
    expect(dayDelta("2026-11-10", "2026-11-08")).toBe(-2);
  });
});
