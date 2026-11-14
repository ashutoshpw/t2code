import { describe, expect, it } from "vite-plus/test";

import { caretIn, id, paragraph, setup, tabsBlocks } from "../test/adapterHarness";
import { activeSpacePane } from "./tabsActive";
import { addPane, fillPane, insertTabs, movePane, removePane, renamePane } from "./tabsCommands";

const titles = (fixture: ReturnType<typeof setup>, tabsId: string) =>
  fixture
    .blocks()
    .filter((block) => block.parentId === id(tabsId))
    .map((block) => (block.content as { title: string }).title);

describe("tabs commands", () => {
  it("inserts tabs with three panes of one empty paragraph, ranked and activated", () => {
    const fixture = setup([paragraph("a", "")]);
    caretIn(fixture, "a");
    expect(fixture.run(insertTabs(fixture.adapter, id("a")))).toBe(true);
    const blocks = fixture.blocks();
    const tabs = blocks.find((block) => block.type === "tabs")!;
    const panes = blocks.filter((block) => block.type === "tab_pane");
    expect(blocks.some((block) => block.id === id("a"))).toBe(false);
    expect(panes.map((pane) => [pane.parentId, (pane.content as { title: string }).title])).toEqual(
      [
        [tabs.id, "Tab 1"],
        [tabs.id, "Tab 2"],
        [tabs.id, "Tab 3"],
      ],
    );
    expect(new Set(panes.map((pane) => pane.order)).size).toBe(3);
    for (const pane of panes)
      expect(blocks.filter((block) => block.parentId === pane.id).map((b) => b.type)).toEqual([
        "paragraph",
      ]);
    expect(blocks.at(-1)?.parentId).toBeNull();
    expect(activeSpacePane(fixture.state, tabs.id)).toBe(panes[0]!.id);
    expect(fixture.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("refuses tabs directly inside tabs and adds an activated pane after the last one", () => {
    const fixture = setup(tabsBlocks());
    expect(fixture.run(insertTabs(fixture.adapter, id("p2")))).toBe(false);
    expect(fixture.run(addPane(fixture.adapter, id("t")))).toBe(true);
    expect(titles(fixture, "t")).toEqual(["One", "Two", "Tab 3"]);
    const added = fixture
      .blocks()
      .filter((block) => block.parentId === id("t"))
      .at(-1)!;
    expect(activeSpacePane(fixture.state, "t")).toBe(added.id);
    expect(fixture.blocks().filter((block) => block.parentId === added.id)).toHaveLength(1);
  });

  it("renames with trimming and rejects empty, unchanged and too long titles", () => {
    const fixture = setup(tabsBlocks());
    expect(fixture.run(renamePane(fixture.adapter, id("p1"), "  Plans  "))).toBe(true);
    expect(titles(fixture, "t")[0]).toBe("Plans");
    for (const title of ["   ", "Plans", "x".repeat(101)])
      expect(fixture.run(renamePane(fixture.adapter, id("p1"), title))).toBe(false);
    expect(fixture.run(renamePane(fixture.adapter, id("p1"), "x".repeat(100)))).toBe(true);
  });

  it("reorders panes and deletes a pane with its content but never the last one", () => {
    const fixture = setup(tabsBlocks());
    expect(fixture.run(movePane(fixture.adapter, id("p2"), id("p1")))).toBe(true);
    expect(titles(fixture, "t")).toEqual(["Two", "One"]);
    expect(fixture.run(movePane(fixture.adapter, id("p2"), null))).toBe(true);
    expect(titles(fixture, "t")).toEqual(["One", "Two"]);
    expect(fixture.run(removePane(fixture.adapter, id("p1")))).toBe(true);
    expect(fixture.blocks().map((block) => block.id)).toEqual([
      id("t"),
      id("p2"),
      id("b"),
      id("z"),
    ]);
    expect(fixture.run(removePane(fixture.adapter, id("p2")))).toBe(false);
  });

  it("writes into an empty pane by adding one paragraph with the caret in it", () => {
    const fixture = setup(tabsBlocks());
    expect(fixture.run(fillPane(fixture.adapter, id("p1")))).toBe(false);
    expect(fixture.run(removePane(fixture.adapter, id("p1")))).toBe(true);
    expect(fixture.run(addPane(fixture.adapter, id("t")))).toBe(true);
    const added = fixture.blocks().find((block) => block.type === "tab_pane" && block.id !== "p2")!;
    const body = fixture.blocks().find((block) => block.parentId === added.id)!;
    expect(fixture.run(fixture.adapter.remove(body.id))).toBe(true);
    expect(fixture.blocks().some((block) => block.parentId === added.id)).toBe(false);
    expect(fixture.run(fillPane(fixture.adapter, added.id))).toBe(true);
    expect(fixture.blocks().filter((block) => block.parentId === added.id)).toHaveLength(1);
  });
});
