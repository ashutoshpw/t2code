import { describe, expect, it } from "vite-plus/test";
import type { SpaceGroupBucket, SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";

import {
  boardCardIntrinsicHeight,
  boardColumnWidth,
  boardPreview,
  headerAggregates,
  laneCellId,
} from "./boardLayout";

describe("board card size and preview", () => {
  it("maps sizes to column widths and grows the card placeholder with a cover", () => {
    expect(
      [undefined, "small", "medium", "large"].map((s) => boardColumnWidth(s as never)),
    ).toEqual([260, 220, 260, 320]);
    expect(boardCardIntrinsicHeight("small", false)).toBe(72);
    expect(boardCardIntrinsicHeight("large", true)).toBe(72 + 128);
  });

  it("reads the preview as a files property, page content or nothing", () => {
    expect(boardPreview({ kind: "property", propertyId: "files" as never })).toEqual({
      propertyId: "files",
      content: false,
    });
    expect(boardPreview({ kind: "page_content" })).toEqual({ propertyId: null, content: true });
    expect(boardPreview({ kind: "none" })).toEqual({ propertyId: null, content: false });
    expect(boardPreview(undefined)).toEqual({ propertyId: null, content: false });
  });
});

describe("column header aggregates", () => {
  const properties = new Map<string, SpaceKnownDatabaseProperty | null>([
    ["a", null],
    ["b", null],
  ]);
  const bucket = (aggregates: object[]) => ({ aggregates }) as unknown as SpaceGroupBucket;
  it("shows at most two results of the calculated properties", () => {
    expect(
      headerAggregates(
        bucket([
          { property: "a", function: "count", number: 3 },
          { property: "z", function: "count", number: 9 },
          { property: "b", function: "sum", number: 1200 },
          { property: "a", function: "empty", number: 1 },
        ]),
        properties,
        "UTC",
      ),
    ).toBe("3 · 1,200");
    expect(headerAggregates(bucket([]), properties, "UTC")).toBe("");
  });

  it("builds one id per lane cell", () => {
    expect(laneCellId(undefined, { kind: "empty" })).toBe('{"kind":"empty"}');
    expect(laneCellId({ kind: "checkbox", value: true }, { kind: "empty" })).toContain("|");
  });
});
