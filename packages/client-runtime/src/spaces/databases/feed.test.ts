import type { SpaceDatabaseView } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { feedPreviewBlocks, feedWindowLimit } from "./feed.ts";

const feed = (layout: SpaceDatabaseView["layout"]) =>
  ({ type: "feed", layout }) as unknown as SpaceDatabaseView;

describe("feed helpers", () => {
  it("reads the preview block count, defaulting to three", () => {
    expect(feedPreviewBlocks(feed({}))).toBe(3);
    expect(feedPreviewBlocks(feed({ previewBlocks: 0 }))).toBe(0);
    expect(feedPreviewBlocks(feed({ previewBlocks: 10 }))).toBe(10);
    expect(feedPreviewBlocks(feed({ previewBlocks: 4 }))).toBe(3);
  });

  it("caps the window at the load limit, the preview window and the query cap", () => {
    expect(feedWindowLimit(feed({}), 500)).toBe(25);
    expect(feedWindowLimit(feed({ loadLimit: 10 }), 500)).toBe(10);
    expect(feedWindowLimit(feed({ loadLimit: 100 }), 500)).toBe(25);
    expect(feedWindowLimit(feed({ loadLimit: 10 }), 5)).toBe(5);
  });
});
