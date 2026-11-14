import { encodeSyncedClipboard } from "@t2code/client-runtime/spaces";
import { EnvironmentId } from "@t2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { caretIn, id, paragraph, setup, syncedBlocks, target } from "../test/adapterHarness";
import { fillSynced, insertSynced, wrapInSynced } from "./syncedCommands";
import { syncedPasteCommand } from "./syncedPaste";

const marker = (environment = target.environmentId) => encodeSyncedClipboard(environment, id("s"));

describe("synced block paste", () => {
  it("inserts a copy after the caret block for this environment's marker", () => {
    const fixture = setup([paragraph("a", "one"), paragraph("b", "two")]);
    caretIn(fixture, "a");
    const command = syncedPasteCommand(fixture.adapter, marker());
    expect(command).not.toBeNull();
    expect(fixture.run(command!)).toBe(true);
    const blocks = fixture.blocks();
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "synced_ref", "paragraph"]);
    expect(blocks[1]).toMatchObject({ content: { sourceBlockId: "s" }, parentId: null });
    expect(blocks[1]!.order > blocks[0]!.order && blocks[1]!.order < blocks[2]!.order).toBe(true);
  });

  it("pastes another environment's marker and ordinary text as text", () => {
    const fixture = setup([paragraph("a", "one")]);
    expect(syncedPasteCommand(fixture.adapter, marker(EnvironmentId.make("other")))).toBeNull();
    expect(syncedPasteCommand(fixture.adapter, "just text")).toBeNull();
  });

  it("falls back to text inside an original, where a copy cannot sit", () => {
    const [original, inside] = syncedBlocks();
    const fixture = setup([original!, inside!]);
    caretIn(fixture, "sa");
    const command = syncedPasteCommand(fixture.adapter, marker());
    expect(fixture.run(command!)).toBe(false);
    expect(fixture.blocks().map((block) => block.type)).toEqual(["synced_block", "paragraph"]);
  });
});

describe("synced block commands", () => {
  it("creates an original with an empty paragraph, but not inside another original", () => {
    const fixture = setup([paragraph("a", "")]);
    caretIn(fixture, "a");
    expect(fixture.run(insertSynced(fixture.adapter, id("a")))).toBe(true);
    expect(fixture.blocks().map((block) => [block.type, block.parentId])).toEqual([
      ["synced_block", null],
      ["paragraph", "new-1"],
      ["paragraph", null],
    ]);
    const nested = setup(syncedBlocks());
    expect(nested.run(insertSynced(nested.adapter, id("sa")))).toBe(false);
  });

  it("wraps a block and its subtree in a new original at the same place", () => {
    const fixture = setup([
      paragraph("a", "one"),
      paragraph("t", "toggle", { type: "toggle", order: "b" }),
      paragraph("c", "child", { parentId: id("t") }),
    ]);
    let created = "";
    expect(fixture.run(wrapInSynced(fixture.adapter, id("t"), (made) => (created = made)))).toBe(
      true,
    );
    expect(fixture.blocks().map((block) => [block.id, block.type, block.parentId])).toEqual([
      ["a", "paragraph", null],
      [created, "synced_block", null],
      ["t", "toggle", created],
      ["c", "paragraph", "t"],
    ]);
    const tabbed = setup([paragraph("x", "", { type: "tabs", content: {} })]);
    expect(tabbed.run(wrapInSynced(tabbed.adapter, id("x")))).toBe(false);
  });

  it("gives an empty original a paragraph to write in", () => {
    const fixture = setup([
      paragraph("s", "", { type: "synced_block", content: {} }),
      paragraph("z", "tail"),
    ]);
    expect(fixture.run(fillSynced(fixture.adapter, id("s")))).toBe(true);
    expect(fixture.blocks().map((block) => [block.type, block.parentId])).toEqual([
      ["synced_block", null],
      ["paragraph", "s"],
      ["paragraph", null],
    ]);
    expect(fixture.run(fillSynced(fixture.adapter, id("s")))).toBe(false);
  });
});
