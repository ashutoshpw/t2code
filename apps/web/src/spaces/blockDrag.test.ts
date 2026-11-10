import { describe, expect, it } from "vite-plus/test";
import { SpaceBlockId, type SpaceBlock } from "@t2code/contracts/spaces";

import { planBlockDrop } from "./blockDrag";

const id = SpaceBlockId.make;
const block = (key: string, parentId: string | null = null): SpaceBlock => ({
  id: id(key),
  parentId: parentId ? id(parentId) : null,
  order: key,
  type: "paragraph",
  version: 1,
  content: { runs: [] },
});
const blocks = [block("a"), block("b"), block("c"), block("child", "a")];
const rect = { top: 100, bottom: 120, left: 30, width: 200 };
const box = { top: 10, left: 5 };
const plan = (dragId: string, targetId: string, after: boolean, canMove = () => true) =>
  planBlockDrop({ blocks, dragId: id(dragId), targetId: id(targetId), after, rect, box, canMove });

describe("planBlockDrop", () => {
  it("places before the target in its sibling list and positions the indicator on its top edge", () => {
    expect(plan("a", "c", false)).toEqual({
      key: "c:false",
      allowed: true,
      parentId: null,
      beforeId: id("c"),
      top: 90,
      left: 25,
      width: 200,
    });
  });

  it("places after the target before its next sibling, or at the end when it is last", () => {
    expect(plan("c", "a", true)?.beforeId).toBe(id("b"));
    expect(plan("a", "c", true)).toMatchObject({ beforeId: null, top: 110 });
  });

  it("refuses a drop that keeps the block where it is and the move command's veto", () => {
    expect(plan("b", "a", true)?.allowed).toBe(false);
    expect(plan("a", "c", false, () => false)?.allowed).toBe(false);
  });

  it("has no plan over the dragged block or an unknown block", () => {
    expect(plan("a", "a", true)).toBeNull();
    expect(plan("a", "missing", true)).toBeNull();
  });
});
