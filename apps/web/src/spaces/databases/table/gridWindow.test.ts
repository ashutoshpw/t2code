import { describe, expect, it } from "vite-plus/test";

import { clampWidth, columnRange, rowRange, scrollToCell } from "./gridWindow";

const offsets = Array.from({ length: 100 }, (_, index) => index * 34);

describe("rowRange", () => {
  it("covers the viewport plus overscan on both sides", () => {
    // 340px down is item 10; a 340px viewport shows 10..20
    expect(rowRange(offsets, 3400, 340, 340)).toEqual({ first: 4, last: 27 });
  });

  it("clamps at both ends", () => {
    expect(rowRange(offsets, 3400, 0, 100).first).toBe(0);
    expect(rowRange(offsets, 3400, 99_999, 600).last).toBe(100);
    expect(rowRange([], 0, 0, 600)).toEqual({ first: 0, last: 0 });
  });

  it("handles mixed heights through the offsets", () => {
    // a 36px group header then 34px rows
    expect(rowRange([0, 36, 70, 104], 138, 40, 10, 0)).toEqual({ first: 1, last: 2 });
  });
});

describe("columnRange", () => {
  const widths = [200, 200, 200, 200, 200, 200];

  it("starts at the first columns without scroll", () => {
    // viewport 800 with a 280 frozen title leaves 520px: columns 0..2, plus one overscan
    expect(columnRange(widths, 280, 0, 800)).toEqual({ first: 0, last: 4 });
  });

  it("moves with the horizontal scroll", () => {
    expect(columnRange(widths, 280, 400, 800)).toEqual({ first: 1, last: 6 });
  });

  it("never returns an empty range for a non-empty column list", () => {
    expect(columnRange(widths, 280, 99_999, 800)).toEqual({ first: 0, last: 2 });
    expect(columnRange([], 280, 0, 800)).toEqual({ first: 0, last: 0 });
  });
});

describe("scrollToCell", () => {
  const input = {
    itemTop: 0,
    itemHeight: 34,
    columnLeft: null,
    columnWidth: 0,
    scrollTop: 0,
    scrollLeft: 0,
    viewportHeight: 400,
    viewportWidth: 800,
    frozenWidth: 280,
    footerHeight: 34,
  };

  it("scrolls up and down by the least amount, leaving room for header and footer", () => {
    expect(scrollToCell({ ...input, itemTop: 1000, scrollTop: 0 }).top).toBe(1000 + 34 - 332);
    expect(scrollToCell({ ...input, itemTop: 100, scrollTop: 500 }).top).toBe(100);
    expect(scrollToCell({ ...input, itemTop: 100, scrollTop: 50 }).top).toBe(50);
  });

  it("brings a column out from under the title or past the right edge", () => {
    expect(scrollToCell({ ...input, columnLeft: 1000, columnWidth: 200, scrollLeft: 0 }).left).toBe(
      1000 + 200 - 520,
    );
    expect(
      scrollToCell({ ...input, columnLeft: 100, columnWidth: 200, scrollLeft: 400 }).left,
    ).toBe(100);
  });
});

describe("clampWidth", () => {
  it("keeps widths between 80 and 800", () => {
    expect(clampWidth(10)).toBe(80);
    expect(clampWidth(5000)).toBe(800);
    expect(clampWidth(150.4)).toBe(150);
  });
});
