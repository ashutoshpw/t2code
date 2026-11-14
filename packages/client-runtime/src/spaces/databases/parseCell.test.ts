import { describe, expect, it } from "vite-plus/test";
import type { SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";

import { numberToText, parseCell, parseLocalizedNumber, parseNumber } from "./parseCell.ts";

const known = (type: string, config: unknown = {}) =>
  ({ id: type, name: type, type, config, position: 0 }) as unknown as SpaceKnownDatabaseProperty;
const options = [
  { id: "bug", name: "Bug", color: "red" },
  { id: "idea", name: "Idea", color: "blue" },
];

describe("parseLocalizedNumber", () => {
  it.each<[string, string, string, number | null | undefined]>([
    [".", "1,234.5", "number", 1234.5],
    [".", "1,234,567", "number", 1234567],
    [".", "1.5", "number", 1.5],
    [".", "-$1,000.25", "dollar", -1000.25],
    [".", "50%", "percent", 0.5],
    [".", "1e3", "number", 1000],
    [".", "", "number", null],
    [",", "1,5", "number", 1.5],
    [",", "0,25", "number", 0.25],
    [",", "1.234,5", "number", 1234.5],
    [",", "1.234.567", "number", 1234567],
    [",", "1 234,5", "number", 1234.5],
    [",", "12,5%", "percent", 0.125],
    [",", "€ 9,99", "number", 9.99],
    // Group separators must make 3-digit groups, and the decimal separator appears once.
    [".", "1,5", "number", undefined],
    [".", "1,2,3", "number", undefined],
    [".", "1,23,456", "number", undefined],
    [".", "1.2.3", "number", undefined],
    [",", "1.5", "number", undefined],
    [",", "1,234.5", "number", undefined],
    [",", "1,2,3", "number", undefined],
    [",", "1.234,5,6", "number", undefined],
    [",", "abc5", "number", undefined],
    [",", ",", "number", undefined],
  ])("under %j reads %j (%s) as %j", (decimal, text, format, expected) => {
    expect(parseLocalizedNumber(text, format, decimal)).toBe(expected);
  });
});

describe("parseCell numbers by locale", () => {
  const number = known("number", { format: "number" });
  it("reads a comma as the decimal mark under a comma-decimal locale", () => {
    expect(parseCell("1,5", number, { decimal: "," })).toEqual({ ok: true, value: 1.5 });
    expect(parseCell("1.234,5", number, { decimal: "," })).toEqual({ ok: true, value: 1234.5 });
  });
  it("shows a number to edit with the locale's decimal mark", () => {
    expect(numberToText(1.5, "number", ",")).toBe("1,5");
    expect(numberToText(1.5, "number")).toBe("1.5");
  });
  it("keeps a comma as a grouping mark otherwise", () => {
    expect(parseCell("1,5", number)).toEqual({ ok: true, value: 15 });
    expect(parseCell("1,5", number, { decimal: "." })).toEqual({ ok: true, value: 15 });
  });
});

describe("parseNumber", () => {
  it("reads signs, decimals, exponents, grouping commas and a leading currency sign", () => {
    expect(parseNumber("1,234.5", "number")).toBe(1234.5);
    expect(parseNumber("-12", "number")).toBe(-12);
    expect(parseNumber("$ 9.99", "dollar")).toBe(9.99);
    expect(parseNumber("-$5", "dollar")).toBe(-5);
    expect(parseNumber("1e3", "number")).toBe(1000);
    expect(parseNumber("", "number")).toBeNull();
  });

  it("divides by 100 for the percent format and rejects anything else", () => {
    expect(parseNumber("50%", "percent")).toBe(0.5);
    expect(parseNumber("12.5", "percent")).toBe(0.125);
    expect(parseNumber("abc", "number")).toBeUndefined();
    expect(parseNumber("1.2.3", "number")).toBeUndefined();
  });

  it("round trips through the editor text", () => {
    expect(numberToText(0.125, "percent")).toBe("12.5");
    expect(numberToText(7, "number")).toBe("7");
  });
});

describe("parseCell", () => {
  it("trims text types and clears on empty", () => {
    expect(parseCell("  hi ", known("title"))).toEqual({ ok: true, value: "hi" });
    expect(parseCell("   ", known("url"))).toEqual({ ok: true, value: null });
    expect(parseCell("note", known("text"))).toEqual({
      ok: true,
      value: [{ text: "note", marks: [] }],
    });
  });

  it("refuses a number that does not parse", () => {
    expect(parseCell("nope", known("number", { format: "number" }))).toEqual({ ok: false });
    expect(parseCell("4", known("number", { format: "number" }))).toEqual({ ok: true, value: 4 });
  });

  it("matches option names case-insensitively and refuses unknown ones", () => {
    const multi = known("multi_select", { options });
    expect(parseCell("bug, IDEA", multi)).toEqual({ ok: true, value: ["bug", "idea"] });
    expect(parseCell("bug, other", multi)).toEqual({ ok: false });
    expect(parseCell("idea", known("select", { options }))).toEqual({ ok: true, value: "idea" });
  });

  it("reads checkbox words and dates", () => {
    expect(parseCell("Yes", known("checkbox"))).toEqual({ ok: true, value: true });
    expect(parseCell("no", known("checkbox"))).toEqual({ ok: true, value: null });
    expect(parseCell("2026-03-04", known("date"))).toEqual({
      ok: true,
      value: { start: "2026-03-04" },
    });
    expect(parseCell("2026-03-04 → 2026-03-06", known("date"))).toEqual({
      ok: true,
      value: { start: "2026-03-04", end: "2026-03-06" },
    });
    expect(parseCell("2026-02-30", known("date"))).toEqual({ ok: false });
  });

  it("cannot write read-only or link types", () => {
    expect(parseCell("x", known("created_time"))).toEqual({ ok: false });
    expect(parseCell("x", known("relation", { dataSourceId: "d", limit: "many" }))).toEqual({
      ok: false,
    });
  });
});
