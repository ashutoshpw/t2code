import { describe, expect, it } from "vite-plus/test";
import type { SpaceDatabaseRow } from "@t2code/contracts/spaces";

import type { GridItem } from "../table/gridItems";
import { buildGalleryLayout, cardHeight, columnsFor, CARD_GAP, AUX_HEIGHT } from "./galleryLayout";

const row = (id: string) => ({ page: { id } }) as unknown as SpaceDatabaseRow;
const item = (id: string): GridItem => ({ kind: "row", row: row(id), group: null });

describe("columnsFor", () => {
  it.each([
    [100, "small", 1],
    [180, "small", 1],
    [372, "small", 2],
    [1000, "small", 5],
    [1000, "medium", 3],
    [1000, "large", 3],
    [1400, "large", 4],
  ] as const)("%dpx %s gives %d columns", (width, size, expected) => {
    expect(columnsFor(width, size)).toBe(expected);
  });
});

describe("cardHeight", () => {
  it("adds the cover, the title and one line per shown property", () => {
    expect(cardHeight("medium", true, 2)).toBe(160 + 36 + 48);
    expect(cardHeight("small", false, 0)).toBe(36);
    expect(cardHeight("large", true, 1)).toBe(200 + 36 + 24);
  });
});

describe("buildGalleryLayout", () => {
  it("packs cards into rows and puts the new card last", () => {
    const layout = buildGalleryLayout({
      items: [item("a"), item("b"), item("c"), { kind: "add", group: null }],
      columns: 2,
      cardHeight: 100,
    });
    expect(layout.items.map((entry) => (entry.kind === "cards" ? entry.cells.length : 0))).toEqual([
      2, 2,
    ]);
    expect(layout.offsets).toEqual([0, 100 + CARD_GAP]);
    expect(layout.total).toBe(2 * (100 + CARD_GAP));
  });

  it("keeps group headers and Load more full width, with the new card before Load more", () => {
    const bucket = { key: { kind: "empty" }, count: 5, rows: [] } as never;
    const key = { kind: "empty" } as const;
    const layout = buildGalleryLayout({
      items: [
        { kind: "group", id: "g", bucket, collapsed: false },
        item("a"),
        { kind: "more", group: key, loading: false },
        { kind: "add", group: key },
        { kind: "group", id: "h", bucket, collapsed: true },
      ],
      columns: 3,
      cardHeight: 50,
    });
    expect(layout.items.map((entry) => entry.kind)).toEqual(["group", "cards", "more", "group"]);
    const cards = layout.items[1]!;
    expect(cards.kind === "cards" && cards.cells.map((cell) => cell.kind)).toEqual(["row", "add"]);
    expect(layout.offsets[3]).toBe(36 + 50 + CARD_GAP + AUX_HEIGHT);
  });
});
