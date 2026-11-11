import type { SpaceDatabaseRow } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import {
  calendarItems,
  gridSpan,
  itemTime,
  itemsOnDay,
  layoutWeek,
  visibleOffsets,
} from "./calendarLayout";

const row = (id: string, date: unknown): SpaceDatabaseRow =>
  ({
    page: { id, title: id, revision: 1, createdAt: "t", updatedAt: "t" },
    number: 1,
    cells: { title: id, d: date },
  }) as unknown as SpaceDatabaseRow;

const items = (...entries: Array<[string, unknown]>) =>
  calendarItems(
    entries.map(([id, date]) => row(id, date)),
    "d",
    "UTC",
  );

const WEEK = "2026-11-08"; // Sunday

describe("calendarItems", () => {
  it("skips rows without a readable date", () => {
    expect(
      items(["a", { start: "2026-11-09" }], ["b", undefined], ["c", { start: "x" }]),
    ).toHaveLength(1);
  });
});

describe("layoutWeek", () => {
  it("puts single days in lane 0 and stacks a second item on the same day", () => {
    const layout = layoutWeek(
      items(
        ["a", { start: "2026-11-09" }],
        ["b", { start: "2026-11-09" }],
        ["c", { start: "2026-11-10" }],
      ),
      WEEK,
    );
    const lane = (id: string) => layout.segments.find((s) => s.item.row.page.id === id)?.lane;
    expect([lane("a"), lane("b"), lane("c")]).toEqual([0, 1, 0]);
    expect(layout.lanes).toBe(2);
  });

  it("places longer items first and cuts a span that crosses the week", () => {
    const layout = layoutWeek(
      items(
        ["short", { start: "2026-11-10" }],
        ["long", { start: "2026-11-05", end: "2026-11-11" }],
      ),
      WEEK,
    );
    const long = layout.segments.find((s) => s.item.row.page.id === "long")!;
    expect([long.first, long.last, long.lane]).toEqual([0, 3, 0]);
    expect([long.continuesBefore, long.continuesAfter]).toEqual([true, false]);
    expect(layout.segments.find((s) => s.item.row.page.id === "short")?.lane).toBe(1);
    const next = layoutWeek(
      items(["long", { start: "2026-11-05", end: "2026-11-11" }]),
      "2026-11-01",
    );
    expect(next.segments[0]).toMatchObject({ first: 4, last: 6, continuesAfter: true });
  });

  it("ignores items outside the week and counts overflow past the lane cap", () => {
    const many = items(
      ...Array.from({ length: 4 }, (_, i): [string, unknown] => [`i${i}`, { start: "2026-11-09" }]),
      ["off", { start: "2026-12-01" }],
    );
    const layout = layoutWeek(many, WEEK, 3);
    expect(layout.segments).toHaveLength(3);
    expect(layout.lanes).toBe(3);
    expect(layout.overflow).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });

  it("orders equal spans by start day and then by query order", () => {
    const layout = layoutWeek(
      items(
        ["late", { start: "2026-11-11" }],
        ["early", { start: "2026-11-09" }],
        ["tie", { start: "2026-11-09" }],
      ),
      WEEK,
    );
    const lanes = Object.fromEntries(layout.segments.map((s) => [s.item.row.page.id, s.lane]));
    expect(lanes).toEqual({ early: 0, tie: 1, late: 0 });
  });
});

describe("visible columns", () => {
  it("hides weekends and maps spans onto the drawn columns", () => {
    const offsets = visibleOffsets(WEEK, false);
    expect(offsets).toEqual([1, 2, 3, 4, 5]);
    expect(gridSpan(0, 6, offsets)).toEqual({ start: 1, end: 6 });
    expect(gridSpan(5, 6, offsets)).toEqual({ start: 5, end: 6 });
    expect(gridSpan(6, 6, offsets)).toBeNull();
    expect(gridSpan(0, 0, offsets)).toBeNull();
    expect(visibleOffsets("2026-11-09", false)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("itemsOnDay and itemTime", () => {
  it("lists every item covering a day and shows the time of a single timed day", () => {
    const all = items(
      ["a", { start: "2026-11-09", end: "2026-11-11" }],
      ["b", { start: "2026-11-10T14:30:00", timeZone: "UTC" }],
    );
    expect(itemsOnDay(all, "2026-11-10").map((i) => i.row.page.id)).toEqual(["a", "b"]);
    expect(itemTime(all[0]!, "d", "UTC")).toBeNull();
    expect(itemTime(all[1]!, "d", "UTC")).toBe("14:30");
  });
});
