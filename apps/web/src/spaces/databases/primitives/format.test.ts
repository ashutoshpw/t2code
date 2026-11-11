import { describe, expect, it } from "vite-plus/test";

import {
  cellPlainText,
  formatAggregate,
  formatDate,
  formatNumber,
  formatTimestamp,
  formatUniqueId,
} from "./format";

describe("formatNumber", () => {
  it.each([
    [1234.5, { format: "number" }, "1234.5"],
    [1234.5, { format: "number_with_commas" }, "1,234.5"],
    [0.256, { format: "percent", decimals: 1 }, "25.6%"],
    [12, { format: "dollar", decimals: 2 }, "$12.00"],
    [3, { format: "euro" }, "€3.00"],
    [2, { format: "number", decimals: 3 }, "2.000"],
  ] as const)("%s %j", (value, config, expected) => {
    expect(formatNumber(value, config)).toBe(expected);
  });
});

describe("formatDate", () => {
  it("keeps date-only values zone-less in every viewer zone", () => {
    for (const zone of ["UTC", "Pacific/Kiritimati", "America/Los_Angeles"])
      expect(formatDate({ start: "2026-05-03" }, {}, zone)).toBe("May 3, 2026");
  });
  it.each([
    ["mdy", "05/03/2026"],
    ["dmy", "03/05/2026"],
    ["ymd", "2026/05/03"],
    ["short", "May 3, 2026"],
  ] as const)("%s", (dateFormat, expected) => {
    expect(formatDate({ start: "2026-05-03" }, { dateFormat }, "UTC")).toBe(expected);
  });
  it("renders wall times, hides or formats time, and ranges", () => {
    const value = {
      start: "2026-05-03T14:05:00",
      end: "2026-05-04T09:00:00",
      timeZone: "Asia/Tokyo",
    };
    expect(formatDate(value, {}, "UTC")).toBe("May 3, 2026 2:05 PM → May 4, 2026 9:00 AM");
    expect(formatDate(value, { timeFormat: "24h" }, "UTC")).toContain("14:05");
    expect(formatDate(value, { timeFormat: "hidden", dateFormat: "ymd" }, "UTC")).toBe(
      "2026/05/03 → 2026/05/04",
    );
  });
  it("converts instants into the viewer zone", () => {
    expect(formatTimestamp("2026-05-03T23:30:00Z", {}, "Asia/Tokyo")).toBe("May 4, 2026 8:30 AM");
  });
});

describe("aggregates and cell text", () => {
  it("reads percentages from fractions and date ranges from milliseconds", () => {
    expect(
      formatAggregate({ property: "p", function: "percent_checked", number: 0.5 } as never, null),
    ).toBe("50%");
    expect(
      formatAggregate(
        { property: "p", function: "date_range", number: 3 * 86_400_000 } as never,
        null,
      ),
    ).toBe("3 days");
    expect(
      formatAggregate(
        {
          property: "p",
          function: "earliest",
          date: { start: "2026-01-02", hasTime: false },
        } as never,
        null,
      ),
    ).toBe("January 2, 2026");
    expect(formatAggregate({ property: "p", function: "count" } as never, null)).toBe("");
    expect(formatUniqueId({ number: 4, prefix: "TSK" })).toBe("TSK-4");
  });
  it("resolves options through hints and relations through related pages", () => {
    const context = {
      relatedPages: { page1: { title: "Linked", dataSourceId: "s" } },
      optionHint: (_p: string, id: string) =>
        id === "late" ? { name: "Late", color: "red" } : undefined,
      timeZone: "UTC",
    } as never;
    const select = {
      id: "sel",
      name: "S",
      type: "multi_select",
      position: 0,
      config: { options: [{ id: "o1", name: "One", color: "blue" }] },
    } as never;
    expect(cellPlainText(["o1", "late", "gone"], select, context)).toBe("One, Late");
    const relation = {
      id: "r",
      name: "R",
      type: "relation",
      position: 0,
      config: { dataSourceId: "s", limit: "many" },
    } as never;
    expect(cellPlainText(["page1", "page2"], relation, context)).toBe("Linked");
    expect(cellPlainText(undefined, select, context)).toBe("");
  });
});
