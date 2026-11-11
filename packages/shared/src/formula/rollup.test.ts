import { describe, expect, it } from "vite-plus/test";
import {
  evaluateRollup,
  rollupFunctionsFor,
  rollupResultType,
  type FormulaType,
  type FormulaValue,
  type RollupFunction,
} from "./index.ts";
import { day, instant, page } from "./testkit.ts";

const ctx = { timeZone: "UTC" };
const roll = (
  fn: RollupFunction,
  perPage: FormulaValue[],
  target: FormulaType,
  timeZone = "UTC",
): FormulaValue => evaluateRollup(fn, perPage, target, { timeZone });

const ALL: ReadonlyArray<RollupFunction> = [
  "show_original",
  "show_unique",
  "count_all",
  "count_values",
  "count_unique",
  "count_empty",
  "count_not_empty",
  "percent_empty",
  "percent_not_empty",
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
  "earliest_date",
  "latest_date",
  "date_range",
  "checked",
  "unchecked",
  "percent_checked",
  "percent_unchecked",
];
const GENERIC = ALL.slice(0, 9);
const NUMERIC = ALL.slice(9, 15);
const DATES = ALL.slice(15, 18);
const BOOLEANS = ALL.slice(18);

describe("which functions apply to which target", () => {
  const farPage: FormulaType = { list: { page: "tasks", far: true } };
  it.each<[string, FormulaType, ReadonlyArray<RollupFunction>]>([
    ["number", "number", [...GENERIC, ...NUMERIC]],
    ["list of number", { list: "number" }, [...GENERIC, ...NUMERIC]],
    ["date", "date", [...GENERIC, ...DATES]],
    ["list of date", { list: "date" }, [...GENERIC, ...DATES]],
    ["boolean", "boolean", [...GENERIC, ...BOOLEANS]],
    ["text", "text", GENERIC],
    ["list of text", { list: "text" }, GENERIC],
    ["pages", farPage, GENERIC],
    ["any", "any", GENERIC],
    ["empty", "empty", GENERIC],
  ])("%s", (_name, target, legal) => {
    expect(rollupFunctionsFor(target)).toEqual(legal);
    for (const fn of ALL) {
      const result = rollupResultType(fn, target);
      if (legal.includes(fn)) expect(result, fn).not.toBeNull();
      else {
        expect(result, fn).toBeNull();
        expect(roll(fn, [1, 2], target), fn).toBeNull();
      }
    }
  });

  it("types the results", () => {
    expect(rollupResultType("show_original", "number")).toEqual({ list: "number" });
    expect(rollupResultType("show_unique", "text")).toEqual({ list: "text" });
    expect(rollupResultType("show_original", { list: "text" })).toEqual({ list: "text" });
    expect(rollupResultType("show_original", "boolean")).toEqual({ list: "boolean" });
    expect(rollupResultType("show_original", { list: { page: "tasks" } })).toEqual({
      list: { page: "tasks", far: true },
    });
    expect(rollupResultType("show_original", "any")).toEqual({ list: "any" });
    expect(rollupResultType("show_original", "empty")).toEqual({ list: "any" });
    for (const fn of GENERIC.slice(2)) expect(rollupResultType(fn, "text")).toBe("number");
    for (const fn of NUMERIC) expect(rollupResultType(fn, "number")).toBe("number");
    for (const fn of DATES) expect(rollupResultType(fn, "date")).toBe("date");
    for (const fn of BOOLEANS) expect(rollupResultType(fn, "boolean")).toBe("number");
  });
});

describe("generic functions", () => {
  const numbers = [1, null, 3, 3];
  it.each<[RollupFunction, FormulaValue]>([
    ["show_original", [1, 3, 3]],
    ["show_unique", [1, 3]],
    ["count_all", 4],
    ["count_values", 3],
    ["count_unique", 2],
    ["count_empty", 1],
    ["count_not_empty", 3],
    ["percent_empty", 0.25],
    ["percent_not_empty", 0.75],
  ])("%s over numbers", (fn, expected) => {
    expect(roll(fn, numbers, "number")).toEqual(expected);
  });

  it("counts a zero as a value, not as empty", () => {
    expect(roll("count_empty", [0, 1, null], "number")).toBe(1);
    expect(roll("percent_not_empty", [0, 1], "number")).toBe(1);
  });

  it("treats empty text and empty lists as empty", () => {
    expect(roll("count_empty", ["a", "", null], "text")).toBe(2);
    expect(roll("count_empty", [["x"], [], null], { list: "text" })).toBe(2);
  });

  it("flattens one level of list values", () => {
    const tags = [["x", "y"], [], ["y"]];
    expect(roll("show_original", tags, { list: "text" })).toEqual(["x", "y", "y"]);
    expect(roll("show_unique", tags, { list: "text" })).toEqual(["x", "y"]);
    expect(roll("count_all", tags, { list: "text" })).toBe(3);
    expect(roll("count_values", tags, { list: "text" })).toBe(3);
    expect(roll("count_unique", tags, { list: "text" })).toBe(2);
    expect(roll("count_empty", tags, { list: "text" })).toBe(1);
  });

  it("works on related pages", () => {
    const target: FormulaType = { list: { page: "tasks", far: true } };
    const perPage = [[page("a", "tasks"), page("b", "tasks")], [page("a", "tasks")], []];
    expect(roll("show_original", perPage, target)).toEqual([
      page("a", "tasks"),
      page("b", "tasks"),
      page("a", "tasks"),
    ]);
    expect(roll("show_unique", perPage, target)).toEqual([page("a", "tasks"), page("b", "tasks")]);
    expect(roll("count_values", perPage, target)).toBe(3);
    expect(roll("count_unique", perPage, target)).toBe(2);
    expect(roll("count_empty", perPage, target)).toBe(1);
  });

  it("handles no related pages", () => {
    expect(roll("count_all", [], "number")).toBe(0);
    expect(roll("count_values", [], "text")).toBe(0);
    expect(roll("show_original", [], "text")).toEqual([]);
    expect(roll("percent_empty", [], "text")).toBeNull();
    expect(roll("percent_not_empty", [], "text")).toBeNull();
  });
});

describe("number functions", () => {
  it.each<[RollupFunction, FormulaValue]>([
    ["sum", 7],
    ["average", 7 / 3],
    ["median", 3],
    ["min", 1],
    ["max", 3],
    ["range", 2],
  ])("%s", (fn, expected) => {
    expect(roll(fn, [1, null, 3, 3], "number")).toEqual(expected);
  });

  it("reads list-of-number targets", () => {
    expect(roll("sum", [[1, 2], [3], []], { list: "number" })).toBe(6);
    expect(
      roll(
        "median",
        [
          [1, 2],
          [3, 4],
        ],
        { list: "number" },
      ),
    ).toBe(2.5);
  });

  it("gives 0 for the sum of nothing and empty for the rest", () => {
    expect(roll("sum", [], "number")).toBe(0);
    expect(roll("sum", [null], "number")).toBe(0);
    for (const fn of ["average", "median", "min", "max", "range"] as const) {
      expect(roll(fn, [null, null], "number"), fn).toBeNull();
      expect(roll(fn, [], "number"), fn).toBeNull();
    }
  });

  it("keeps floating results finite", () => {
    expect(roll("sum", [0.1, 0.2], "number")).toBeCloseTo(0.3);
    expect(roll("sum", [Number.MAX_VALUE, Number.MAX_VALUE], "number")).toBeNull();
  });
});

describe("date functions", () => {
  const range = {
    kind: "date" as const,
    start: Date.UTC(2024, 2, 5),
    end: Date.UTC(2024, 2, 20),
    timed: false,
  };
  const single = day(2024, 3, 10);
  it("takes the earliest start and the latest end", () => {
    const pages = [single, range, null];
    expect(roll("earliest_date", pages, "date")).toEqual(day(2024, 3, 5));
    expect(roll("latest_date", pages, "date")).toEqual(day(2024, 3, 20));
    expect(roll("date_range", pages, "date")).toEqual({
      kind: "date",
      start: Date.UTC(2024, 2, 5),
      end: Date.UTC(2024, 2, 20),
      timed: false,
    });
  });

  it("gives a single date when the extremes coincide", () => {
    expect(roll("date_range", [single], "date")).toEqual(single);
    expect(roll("date_range", [single, single], "date")).toEqual(single);
  });

  it("works on timed values and keeps the zone of the extreme", () => {
    const a = instant(Date.UTC(2024, 2, 1, 8), "Asia/Kolkata");
    const b = instant(Date.UTC(2024, 2, 3, 9));
    expect(roll("earliest_date", [b, a], "date")).toEqual(a);
    expect(roll("latest_date", [b, a], "date")).toEqual(b);
    expect(roll("date_range", [b, a], "date")).toEqual({
      kind: "date",
      start: Date.UTC(2024, 2, 1, 8),
      end: Date.UTC(2024, 2, 3, 9),
      timed: true,
    });
  });

  it("compares date-only and timed values in the given zone", () => {
    const d = day(2024, 3, 12);
    const t = instant(Date.UTC(2024, 2, 12, 2));
    expect(roll("earliest_date", [d, t], "date", "UTC")).toEqual(d);
    expect(roll("earliest_date", [d, t], "date", "America/New_York")).toEqual(t);
    expect(roll("date_range", [day(2024, 3, 10), t], "date", "UTC")).toEqual({
      kind: "date",
      start: Date.UTC(2024, 2, 10),
      end: Date.UTC(2024, 2, 12, 2),
      timed: true,
    });
  });

  it("reads list-of-date targets and gives empty for nothing", () => {
    expect(roll("earliest_date", [[single, day(2024, 3, 2)]], { list: "date" })).toEqual(
      day(2024, 3, 2),
    );
    for (const fn of DATES) {
      expect(roll(fn, [], "date"), fn).toBeNull();
      expect(roll(fn, [null], "date"), fn).toBeNull();
    }
  });
});

describe("checkbox functions", () => {
  const boxes = [true, false, null, true];
  it.each<[RollupFunction, FormulaValue]>([
    ["checked", 2],
    ["unchecked", 2],
    ["percent_checked", 0.5],
    ["percent_unchecked", 0.5],
    ["count_empty", 2],
    ["count_all", 4],
    ["show_original", [true, false, true]],
    ["show_unique", [true, false]],
  ])("%s", (fn, expected) => {
    expect(roll(fn, boxes, "boolean")).toEqual(expected);
  });

  it("handles no pages", () => {
    expect(roll("checked", [], "boolean")).toBe(0);
    expect(roll("unchecked", [], "boolean")).toBe(0);
    expect(roll("percent_checked", [], "boolean")).toBeNull();
    expect(roll("percent_unchecked", [], "boolean")).toBeNull();
  });

  it("uses no time zone for anything but dates", () => {
    expect(evaluateRollup("checked", [true], "boolean", ctx)).toBe(1);
  });
});
