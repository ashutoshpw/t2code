import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";

import { caretIn, id, setup, tabsBlocks } from "../test/adapterHarness";
import { activeSpacePane, switchSpacePane } from "./tabsActive";

const hidden = (fixture: ReturnType<typeof setup>) => {
  const ids: string[] = [];
  fixture.state.doc.descendants((node) => {
    if (node.type.name === "tabPane") ids.push((node.attrs.block as { id: string }).id);
  });
  return ids.filter((pane) => activeSpacePane(fixture.state, "t") !== pane);
};

describe("spaceTabsPlugin", () => {
  it("opens the first pane, switches by meta, and never changes the document", () => {
    const fixture = setup(tabsBlocks());
    const before = fixture.state.doc;
    expect(activeSpacePane(fixture.state, "t")).toBe("p1");
    expect(hidden(fixture)).toEqual(["p2"]);
    fixture.dispatch(switchSpacePane(fixture.state, "t", "p2"));
    expect(activeSpacePane(fixture.state, "t")).toBe("p2");
    expect(fixture.state.doc).toBe(before);
    expect(fixture.blocks().map((block) => block.id)).toEqual(
      tabsBlocks().map((block) => block.id),
    );
  });

  it("moves a caret out of the pane being hidden and follows the caret into a hidden pane", () => {
    const fixture = setup(tabsBlocks());
    caretIn(fixture, "a");
    fixture.dispatch(switchSpacePane(fixture.state, "t", "p2"));
    expect(fixture.state.selection.$from.parent.textContent).toBe("beta");
    fixture.dispatch(fixture.state.tr);
    expect(activeSpacePane(fixture.state, "t")).toBe("p2");
    caretIn(fixture, "a");
    expect(activeSpacePane(fixture.state, "t")).toBe("p1");
  });

  it("falls back to the first pane when the open pane is deleted", () => {
    const fixture = setup(tabsBlocks());
    fixture.dispatch(switchSpacePane(fixture.state, "t", "p2"));
    expect(fixture.run(fixture.adapter.remove(id("p2")))).toBe(true);
    expect(activeSpacePane(fixture.state, "t")).toBe("p1");
  });

  it("keeps the open pane when the editor state is recreated", () => {
    const fixture = setup(tabsBlocks());
    fixture.dispatch(switchSpacePane(fixture.state, "t", "p2"));
    const { state } = fixture;
    const recreated = EditorState.create({
      doc: state.doc,
      selection: state.selection,
      plugins: state.plugins,
    });
    expect(activeSpacePane(recreated, "t")).toBe("p2");
  });
});
