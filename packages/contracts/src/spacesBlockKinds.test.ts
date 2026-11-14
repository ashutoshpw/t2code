import { describe, expect, it } from "vite-plus/test";

import { spaceHoldsChildren, spaceMovesAllowed, spaceNestingAllowed } from "./spacesBlockKinds.ts";

describe("spaceNestingAllowed", () => {
  it.each([
    ["tab_pane", ["tabs"], true],
    ["tab_pane", [], false],
    ["tab_pane", ["paragraph"], false],
    ["tab_pane", ["tab_pane", "tabs"], false],
    ["paragraph", ["tabs"], false],
    ["paragraph", ["tab_pane", "tabs"], true],
    ["bulleted_item", ["tab_pane", "tabs"], true],
    ["tabs", ["tab_pane", "tabs"], true],
    ["tabs", [], true],
    ["paragraph", ["paragraph"], false],
    ["paragraph", ["toggle"], true],
    ["synced_block", [], true],
    ["synced_block", ["tab_pane", "tabs"], true],
    ["synced_block", ["synced_block"], false],
    ["synced_block", ["toggle", "synced_block"], false],
    ["synced_ref", [], true],
    ["synced_ref", ["synced_block"], false],
    ["synced_ref", ["toggle", "synced_block"], false],
    ["tabs", ["synced_block"], false],
    ["database", ["toggle", "synced_block"], false],
    ["child_page", ["synced_block"], false],
    ["paragraph", ["toggle", "synced_block"], true],
    ["paragraph", ["synced_ref"], false],
  ])("%s under %j is %s", (child, ancestors, allowed) => {
    expect(spaceNestingAllowed(child, ancestors)).toBe(allowed);
  });

  it("knows which kinds hold children", () => {
    expect(
      ["tabs", "tab_pane", "toggle", "todo_item", "synced_block"].every(spaceHoldsChildren),
    ).toBe(true);
    expect(["paragraph", "database", "code", "synced_ref"].some(spaceHoldsChildren)).toBe(false);
  });
});

describe("spaceMovesAllowed", () => {
  it("checks descendants of moved blocks against a synced destination", () => {
    const moved = [
      { depth: 1, type: "toggle" },
      { depth: 2, type: "tabs" },
    ];
    expect(spaceMovesAllowed(moved, ["synced_block"])).toBe(false);
    expect(spaceMovesAllowed(moved, [])).toBe(true);
    expect(spaceMovesAllowed([{ depth: 1, type: "synced_block" }], ["synced_block"])).toBe(false);
  });
});
