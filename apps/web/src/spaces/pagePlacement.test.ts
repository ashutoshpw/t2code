import { describe, expect, it } from "vite-plus/test";
import { SpaceBlockId, SpacePageId } from "@t2code/contracts/spaces";

import { placementAfterBlock } from "./pagePlacement";

const id = SpaceBlockId.make;
const pageId = SpacePageId.make("page");
const blocks = [
  { id: id("a"), parentId: null },
  { id: id("a1"), parentId: id("a") },
  { id: id("b"), parentId: null },
];

describe("placementAfterBlock", () => {
  it("places before the next top-level block", () => {
    expect(placementAfterBlock(pageId, blocks, id("a"))).toEqual({
      pageId,
      parentId: null,
      beforeBlockId: id("b"),
    });
  });

  it("places after a nested block's top-level ancestor", () => {
    expect(placementAfterBlock(pageId, blocks, id("a1")).beforeBlockId).toBe(id("b"));
  });

  it("appends after the last block or an unknown cursor", () => {
    expect(placementAfterBlock(pageId, blocks, id("b")).beforeBlockId).toBeNull();
    expect(placementAfterBlock(pageId, blocks, null).beforeBlockId).toBeNull();
  });
});
