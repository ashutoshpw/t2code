import { describe, expect, it } from "vite-plus/test";
import { SpaceBlockId, type SpaceBlock } from "@t2code/contracts/spaces";

import {
  isMobileReadOnlyBlock,
  syncedRefNotice,
  syncedRefSource,
  visibleSpaceBlocks,
} from "./blockVisibility";

function block(
  id: string,
  type: string,
  parentId: string | null,
  content: Record<string, unknown> = {},
): SpaceBlock {
  return {
    id: SpaceBlockId.make(id),
    parentId: parentId === null ? null : SpaceBlockId.make(parentId),
    version: 1,
    order: id,
    type,
    content,
  } as SpaceBlock;
}

const tabs = block("tabs", "tabs", null);
const one = block("one", "tab_pane", "tabs", { title: "One" });
const two = block("two", "tab_pane", "tabs", { title: "Two", icon: "📌" });
const inOne = block("in-one", "paragraph", "one", { runs: [] });
const nested = block("nested", "bulleted_item", "one", { runs: [] });
const inNested = block("in-nested", "paragraph", "nested", { runs: [] });
const inTwo = block("in-two", "paragraph", "two", { runs: [] });
const after = block("after", "paragraph", null, { runs: [] });
const page = [tabs, one, inOne, nested, inNested, two, inTwo, after];
const ids = (rows: ReturnType<typeof visibleSpaceBlocks>) => rows.map((row) => row.block.id);

describe("visibleSpaceBlocks", () => {
  it("shows the first pane by default and hides pane rows", () => {
    const rows = visibleSpaceBlocks(page, new Map());
    expect(ids(rows)).toEqual(["tabs", "in-one", "nested", "in-nested", "after"]);
    expect(rows[0]?.tabs).toEqual({
      panes: [
        { id: "one", title: "One" },
        { id: "two", title: "Two", icon: "📌" },
      ],
      active: "one",
    });
    expect(rows.map((row) => row.depth)).toEqual([0, 0, 0, 1, 0]);
  });

  it("switches panes and hides the inactive pane's descendants", () => {
    const rows = visibleSpaceBlocks(page, new Map([["tabs", "two"]]));
    expect(ids(rows)).toEqual(["tabs", "in-two", "after"]);
    expect(rows[0]?.tabs?.active).toBe("two");
  });

  it("falls back to the first pane when the chosen one is not loaded", () => {
    const rows = visibleSpaceBlocks(page, new Map([["tabs", "gone"]]));
    expect(rows[0]?.tabs?.active).toBe("one");
  });

  it("handles panes that are not loaded yet", () => {
    const rows = visibleSpaceBlocks([tabs, after], new Map());
    expect(rows[0]?.tabs).toEqual({ panes: [], active: "" });
    expect(ids(rows)).toEqual(["tabs", "after"]);
  });
});

describe("isMobileReadOnlyBlock", () => {
  it("covers tabs, synced kinds and anything beneath them", () => {
    const synced = block("synced", "synced_block", null);
    const inSynced = block("in-synced", "paragraph", "synced", { runs: [] });
    const all = [...page, synced, inSynced];
    expect(isMobileReadOnlyBlock(all, tabs)).toBe(true);
    expect(isMobileReadOnlyBlock(all, inNested)).toBe(true);
    expect(isMobileReadOnlyBlock(all, inSynced)).toBe(true);
    expect(isMobileReadOnlyBlock(all, block("r", "synced_ref", null))).toBe(true);
    expect(isMobileReadOnlyBlock(all, after)).toBe(false);
  });
});

describe("syncedRefNotice", () => {
  it.each([
    ["found", null],
    ["deleted", "The original synced block was deleted."],
    ["unavailable", "The original is unavailable (it may be in Trash)."],
  ] as const)("maps %s", (status, notice) => {
    expect(syncedRefNotice(status)).toBe(notice);
  });
});

describe("syncedRefSource", () => {
  it("reads the original's id and rejects malformed copies", () => {
    expect(syncedRefSource(block("r", "synced_ref", null, { sourceBlockId: "src" }))).toBe("src");
    expect(syncedRefSource(block("r", "synced_ref", null, { sourceBlockId: 3 }))).toBeNull();
    expect(syncedRefSource(block("r", "paragraph", null, { sourceBlockId: "src" }))).toBeNull();
  });
});
