import { describe, expect, it } from "vite-plus/test";
import { Fragment } from "@tiptap/pm/model";
import { getSchema } from "@tiptap/core";
import {
  EditorState,
  NodeSelection,
  TextSelection,
  type Command,
  type Transaction,
} from "@tiptap/pm/state";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceBlockId, SpacePageId, type SpaceBlock } from "@t2code/contracts/spaces";

import { SpaceEditorAdapter, type SpaceEditorOptions } from "./adapter";
import { spaceDocumentBlocks } from "./document";
import { isSpaceToggleCollapsed, spaceToggleCollapseKey } from "./toggleCollapse";

const id = SpaceBlockId.make;
const target = { environmentId: EnvironmentId.make("env"), pageId: SpacePageId.make("page") };
function paragraph(key: string, text: string, extra: Partial<SpaceBlock> = {}): SpaceBlock {
  return {
    id: id(key),
    parentId: null,
    order: key,
    type: "paragraph",
    version: 1,
    content: { runs: [{ text, marks: [] }] },
    ...extra,
  };
}
function setup(blocks: readonly SpaceBlock[], overrides: Partial<SpaceEditorOptions> = {}) {
  let sequence = 0;
  const adapter = new SpaceEditorAdapter({
    target,
    window: {
      revision: 17,
      blocks,
      completeParents: [
        null,
        ...blocks
          .filter((block) => block.type.endsWith("_item") || block.type === "toggle")
          .map((block) => block.id),
      ],
    },
    maxBlocks: 50,
    maxDepth: 8,
    maxTextLength: 10000,
    maxClipboardBytes: 20000,
    allocateId: () => id(`new-${++sequence}`),
    allocateOrder: ({ before }) => `${before ?? ""}~${++sequence}`,
    ...overrides,
  });
  const schema = getSchema(adapter.extensions());
  let state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON(adapter.document.toJSON()),
    plugins: adapter.plugins(),
  });
  const dispatch = (tr: Transaction) => {
    state = state.applyTransaction(tr).state;
  };
  return {
    adapter,
    get state() {
      return state;
    },
    dispatch,
    run: (command: Command) => command(state, dispatch),
    blocks: () => spaceDocumentBlocks(state.doc),
  };
}

describe("Spaces ProseMirror adapter", () => {
  it("round-trips independent canonical rich, list, media, and opaque fixtures without stripping future data", () => {
    const blocks: SpaceBlock[] = [
      paragraph("a", "", {
        type: "heading",
        content: {
          level: 3,
          runs: [
            {
              text: "hello",
              marks: [
                { type: "bold", version: 1 },
                { type: "link", version: 1, href: "https://example.test" },
              ],
            },
            { text: "", marks: [] },
          ],
        },
      }),
      paragraph("b", "parent", {
        type: "todo_item",
        content: { checked: true, runs: [{ text: "parent", marks: [] }] },
      }),
      paragraph("c", "child", { parentId: id("b"), type: "quote" }),
      paragraph("d", "", {
        type: "image",
        content: { assetId: "asset-1", caption: [{ text: "caption", marks: [] }] },
      }),
      paragraph("e", "", {
        type: "future",
        version: 9,
        content: { mystery: [true, { x: 1 }] },
        futureEnvelope: "retain",
      }),
      paragraph("f", "", {
        content: {
          runs: [
            { text: "future mark", marks: [{ type: "highlight", version: 4, color: "amber" }] },
          ],
        },
      }),
      paragraph("g", "", {
        type: "paragraph",
        version: 2,
        content: { runs: [{ text: "version", marks: [] }] },
      }),
      paragraph("h", "", { type: "code", content: { text: "one\ntwo", language: "ts" } }),
      paragraph("i", "", { type: "child_page", content: { pageId: "nested" } }),
    ];
    const editor = setup(blocks);
    expect(editor.blocks()).toEqual(blocks);
    expect(editor.state.doc.child(1).firstChild?.attrs).toEqual({});
    expect(editor.state.doc.child(4).type.name).toBe("spaceAtom");
    editor.dispatch(editor.state.tr.insertText("!", 2));
    expect(editor.blocks().slice(1)).toEqual(blocks.slice(1));
    const futurePos = editor.state.doc.content.size - editor.state.doc.lastChild!.nodeSize;
    editor.dispatch(editor.state.tr.delete(futurePos, editor.state.doc.content.size));
    expect(editor.blocks().at(-1)).toEqual(blocks.at(-1));
  });

  it("keeps opaque JSON immutable when a generic transaction replaces an empty object with an array", () => {
    const blocks = [paragraph("a", "", { type: "future", content: {} })];
    const editor = setup(blocks);
    editor.dispatch(
      editor.state.tr.setNodeMarkup(0, undefined, { block: { ...blocks[0], content: [] } }),
    );
    expect(editor.blocks()).toEqual(blocks);
  });

  it("edits rich runs through real mark and text transactions and rejects unsafe link marks", () => {
    const editor = setup([paragraph("a", "abcd")]);
    editor.dispatch(
      editor.state.tr.addMark(
        1,
        3,
        editor.state.schema.marks.space_bold!.create({ value: { type: "bold", version: 1 } }),
      ),
    );
    editor.dispatch(editor.state.tr.insertText("X", 2));
    expect(editor.blocks()).toEqual([
      paragraph("a", "", {
        content: {
          runs: [
            { text: "aXb", marks: [{ type: "bold", version: 1 }] },
            { text: "cd", marks: [] },
          ],
        },
      }),
    ]);
    const before = editor.state.doc;
    editor.dispatch(
      editor.state.tr.addMark(
        1,
        3,
        editor.state.schema.marks.space_link!.create({
          value: { type: "link", version: 1, href: "javascript:alert(1)" },
        }),
      ),
    );
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it("preserves every loaded descendant below an opaque list without exposing structural edits", () => {
    const blocks = [
      paragraph("a", "", {
        type: "bulleted_item",
        content: { runs: [{ text: "future", marks: [{ type: "highlight", version: 2 }] }] },
      }),
      paragraph("b", "nested list", { type: "bulleted_item", parentId: id("a") }),
      paragraph("c", "nested leaf", { parentId: id("b") }),
      paragraph("d", "", {
        parentId: id("b"),
        type: "image",
        content: { assetId: "opaque-descendant" },
      }),
    ];
    const editor = setup(blocks, { canEditMedia: () => true });
    expect(editor.blocks()).toEqual(blocks);
    expect(editor.run(editor.adapter.removeMedia(id("d")))).toBe(false);
    expect(editor.blocks()).toEqual(blocks);
    expect(editor.run(editor.adapter.move(id("a"), null))).toBe(false);
    expect(() => editor.adapter.copyBlocks(editor.state, [id("a")])).toThrow();
  });

  it("converts a populated list between list types without dropping descendants or changing IDs", () => {
    const blocks = [
      paragraph("a", "parent", { type: "bulleted_item" }),
      paragraph("b", "child", { parentId: id("a") }),
    ];
    const editor = setup(blocks);
    expect(editor.run(editor.adapter.convert(id("a"), "todo_item"))).toBe(true);
    expect(editor.blocks()).toEqual([
      paragraph("a", "", {
        type: "todo_item",
        content: { checked: false, runs: [{ text: "parent", marks: [] }] },
      }),
      blocks[1],
    ]);
    expect(editor.run(editor.adapter.convert(id("a"), "paragraph"))).toBe(false);
    expect(editor.run(editor.adapter.undoLocal())).toBe(true);
    expect(editor.blocks()).toEqual(blocks);
  });

  it("turns a paragraph into a toggle that keeps its children when converted to another list", () => {
    const editor = setup([paragraph("a", "hi")]);
    expect(editor.run(editor.adapter.convert(id("a"), "toggle"))).toBe(true);
    expect(editor.blocks()).toEqual([paragraph("a", "hi", { type: "toggle" })]);
    editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 4)));
    expect(editor.run(editor.adapter.split())).toBe(true);
    expect(editor.run(editor.adapter.convert(id("a"), "bulleted_item"))).toBe(true);
    expect(editor.blocks().map((block) => [block.id, block.type, block.parentId])).toEqual([
      ["a", "bulleted_item", null],
      ["new-2", "paragraph", "a"],
    ]);
  });

  it("creates the first child when splitting at the end of an expanded toggle, and a sibling that leaves the children behind when collapsed", () => {
    const blocks = [
      paragraph("a", "hi", { type: "toggle" }),
      paragraph("b", "old", { parentId: id("a"), order: "b" }),
    ];
    const editor = setup(blocks, {
      allocateOrder: ({ parentId, before, after }) =>
        `${parentId ?? "root"}:${before ?? "start"}:${after ?? "end"}`,
    });
    editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 4)));
    expect(editor.run(editor.adapter.split())).toBe(true);
    expect(editor.blocks().map((block) => [block.id, block.type, block.parentId])).toEqual([
      ["a", "toggle", null],
      ["new-1", "paragraph", "a"],
      ["b", "paragraph", "a"],
    ]);
    expect(editor.state.selection.$from.parent.attrs.block.id).toBe("new-1");

    const collapsed = setup(blocks);
    collapsed.dispatch(collapsed.state.tr.setMeta(spaceToggleCollapseKey(), "a"));
    collapsed.dispatch(
      collapsed.state.tr.setSelection(TextSelection.create(collapsed.state.doc, 4)),
    );
    expect(collapsed.run(collapsed.adapter.split())).toBe(true);
    expect(collapsed.blocks().map((block) => [block.id, block.parentId])).toEqual([
      ["a", null],
      ["b", "a"],
      ["new-1", null],
    ]);
  });

  it("keeps collapse state through edits", () => {
    const editor = setup([paragraph("a", "hi", { type: "toggle" }), paragraph("z", "tail")]);
    editor.dispatch(editor.state.tr.setMeta(spaceToggleCollapseKey(), "a"));
    editor.dispatch(editor.state.tr.insertText("x", 4));
    expect(isSpaceToggleCollapsed(editor.state, "a")).toBe(true);
    expect(isSpaceToggleCollapsed(editor.state, "z")).toBe(false);
  });

  it("rejects reparenting through generic transforms even when IDs and traversal order stay unchanged", () => {
    const blocks = [paragraph("a", "list", { type: "bulleted_item" }), paragraph("b", "outside")];
    const editor = setup(blocks, { window: { revision: 17, blocks, completeParents: [] } });
    const first = editor.state.doc.child(0);
    const second = editor.state.doc.child(1);
    const nested = first.type.create(first.attrs, first.content.append(Fragment.from(second)));
    editor.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, nested));
    expect(editor.blocks()).toEqual(blocks);
  });

  it("splits in one history transaction, keeps the first ID, and restores the same IDs on undo/redo", () => {
    const editor = setup([paragraph("a", "hello")]);
    editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)));
    expect(editor.run(editor.adapter.split())).toBe(true);
    expect(editor.blocks()).toEqual([
      paragraph("a", "he"),
      paragraph("new-1", "llo", { order: "a~2" }),
    ]);
    expect(editor.adapter.batch(editor.state)).toMatchObject({
      baseRevision: 17,
      memberIds: ["a"],
      mutations: [{ kind: "replace" }, { kind: "insert" }],
    });
    expect(editor.run(editor.adapter.undoLocal())).toBe(true);
    expect(editor.blocks()).toEqual([paragraph("a", "hello")]);
    expect(editor.run(editor.adapter.redoLocal())).toBe(true);
    expect(editor.blocks().map((block) => block.id)).toEqual(["a", "new-1"]);
  });

  it.each([
    { boundary: "an unloaded parent", parentId: id("p") },
    { boundary: "the complete page root", parentId: null },
  ])("splits within $boundary across exposed foreign children", ({ parentId }) => {
    const namespace = parentId ?? "root";
    const blocks = [
      paragraph("a", "hello", { parentId, order: `${namespace}:first` }),
      paragraph("b", "foreign first", { parentId: id("q"), order: "q:first" }),
      paragraph("c", "world", { parentId, order: `${namespace}:last` }),
      paragraph("d", "foreign last", { parentId: id("q"), order: "q:last" }),
    ];
    const editor = setup(blocks, {
      window: { revision: 17, blocks, completeParents: [parentId, id("q")] },
      allocateOrder: ({ parentId, before, after }) => {
        const namespace = parentId ?? "root";
        if ([before, after].some((order) => order !== null && !order.startsWith(`${namespace}:`)))
          throw new Error("Foreign sibling rank");
        return `${namespace}:${before ?? "start"}:${after ?? "end"}`;
      },
    });
    editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)));
    expect(editor.run(editor.adapter.split())).toBe(true);
    let lastSiblingPos = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.attrs.block?.id === "c") lastSiblingPos = pos;
    });
    editor.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, lastSiblingPos + 3)),
    );
    expect(editor.run(editor.adapter.split())).toBe(true);
    expect(editor.blocks()).toEqual([
      paragraph("a", "he", { parentId, order: `${namespace}:first` }),
      paragraph("new-1", "llo", {
        parentId,
        order: `${namespace}:${namespace}:first:${namespace}:last`,
      }),
      blocks[1],
      paragraph("c", "wo", { parentId, order: `${namespace}:last` }),
      paragraph("new-2", "rld", { parentId, order: `${namespace}:${namespace}:last:end` }),
      blocks[3],
    ]);
  });

  it("joins actual text nodes and emits an explicit merged_into tombstone for the second ID", () => {
    const editor = setup([paragraph("a", "one"), paragraph("b", "two")]);
    editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)));
    expect(editor.run(editor.adapter.joinBackward())).toBe(true);
    expect(editor.blocks()).toEqual([
      paragraph("a", "", {
        content: {
          runs: [
            { text: "one", marks: [] },
            { text: "two", marks: [] },
          ],
        },
      }),
    ]);
    expect(editor.adapter.batch(editor.state).mutations).toContainEqual({
      kind: "delete",
      blockId: "b",
      mergedInto: "a",
    });
    expect(editor.run(editor.adapter.undoLocal())).toBe(true);
    expect(editor.blocks()).toEqual([paragraph("a", "one"), paragraph("b", "two")]);
    expect(editor.run(editor.adapter.redoLocal())).toBe(true);
    expect(editor.adapter.batch(editor.state).mutations).toContainEqual({
      kind: "delete",
      blockId: "b",
      mergedInto: "a",
    });
  });

  it.each([
    {
      boundary: "adjacent code blocks",
      blocks: [
        paragraph("a", "", { type: "code", content: { text: "one", language: "ts" } }),
        paragraph("b", "", { type: "code", content: { text: "two", language: "ts" } }),
      ],
      completeParents: [null],
    },
    {
      boundary: "distinct unloaded parents with complete child membership",
      blocks: [
        paragraph("a", "one", { parentId: id("unloaded-first") }),
        paragraph("b", "two", { parentId: id("unloaded-second") }),
      ],
      completeParents: [id("unloaded-first"), id("unloaded-second")],
    },
  ])(
    "refuses joining $boundary without throwing or changing editor state",
    ({ blocks, completeParents }) => {
      const editor = setup(blocks, { window: { revision: 17, blocks, completeParents } });
      editor.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, editor.state.doc.firstChild!.nodeSize + 1),
        ),
      );
      const before = editor.state;
      const batch = editor.adapter.batch(before);
      expect(editor.adapter.joinBackward()(editor.state)).toBe(false);
      expect(editor.run(editor.adapter.joinBackward())).toBe(false);
      expect(editor.state).toBe(before);
      expect(editor.adapter.batch(editor.state)).toBe(batch);
      expect(editor.blocks()).toEqual(blocks);
    },
  );

  it("converts and wraps text, then indents, outdents, and reorders without changing IDs", () => {
    const editor = setup([paragraph("a", "parent"), paragraph("b", "child")]);
    expect(editor.run(editor.adapter.convert(id("a"), "bulleted_item"))).toBe(true);
    const converted = editor;
    expect(converted.run(converted.adapter.move(id("b"), id("a")))).toBe(true);
    expect(converted.blocks().map((block) => [block.id, block.parentId])).toEqual([
      ["a", null],
      ["b", "a"],
    ]);
    expect(converted.run(converted.adapter.move(id("b"), null, id("a")))).toBe(true);
    expect(converted.blocks().map((block) => [block.id, block.parentId])).toEqual([
      ["b", null],
      ["a", null],
    ]);
    expect(converted.run(converted.adapter.convert(id("b"), "quote"))).toBe(true);
    expect(converted.blocks()[0]).toMatchObject({
      id: "b",
      type: "quote",
      content: { runs: [{ text: "child", marks: [] }] },
    });
    expect(converted.run(converted.adapter.convert(id("b"), "heading"))).toBe(true);
    expect(converted.blocks()[0]).toMatchObject({
      id: "b",
      type: "heading",
      content: { level: 1 },
    });
  });

  it("reorders blocks among siblings by id or by the caret block, keeping the caret", () => {
    const editor = setup([paragraph("a", "one"), paragraph("b", "two"), paragraph("c", "three")]);
    expect(editor.run(editor.adapter.shift(-1, id("a")))).toBe(false);
    expect(editor.run(editor.adapter.shift(1, id("c")))).toBe(false);
    expect(editor.run(editor.adapter.shift(1, id("a")))).toBe(true);
    expect(editor.blocks().map((block) => block.id)).toEqual(["b", "a", "c"]);
    editor.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, editor.state.doc.firstChild!.nodeSize + 3),
      ),
    );
    expect(editor.run(editor.adapter.shift(-1))).toBe(true);
    expect(editor.blocks().map((block) => block.id)).toEqual(["a", "b", "c"]);
    expect(editor.state.selection.$from.parent.textContent).toBe("one");
    expect(editor.state.selection.$from.parentOffset).toBe(2);
  });

  it("refuses to reorder or duplicate when structure changes are not allowed", () => {
    const blocks = [paragraph("a", "one"), paragraph("b", "two")];
    const editor = setup(blocks, { canChangeStructure: () => false });
    expect(editor.adapter.shift(1, id("a"))(editor.state)).toBe(false);
    expect(editor.adapter.move(id("a"), null)(editor.state)).toBe(false);
    expect(editor.adapter.duplicate(id("a"))(editor.state)).toBe(false);
    expect(editor.adapter.insertAfter(id("a"))(editor.state)).toBe(false);
    expect(editor.blocks()).toEqual(blocks);
  });

  it("duplicates a block subtree after the original with fresh ids", () => {
    const editor = setup([
      paragraph("a", "parent", { type: "bulleted_item" }),
      paragraph("b", "child", { parentId: id("a") }),
      paragraph("z", "last"),
    ]);
    expect(editor.run(editor.adapter.duplicate(id("a")))).toBe(true);
    expect(editor.blocks().map((block) => [block.id, block.parentId])).toEqual([
      ["a", null],
      ["b", "a"],
      ["new-1", null],
      ["new-2", "new-1"],
      ["z", null],
    ]);
    const orders = editor.blocks().filter((block) => block.parentId === null);
    expect(orders[1]!.order > orders[0]!.order).toBe(true);
  });

  it("inserts an empty paragraph below a block and parks the caret after the seed text", () => {
    const editor = setup([paragraph("a", "one"), paragraph("b", "two")]);
    expect(editor.run(editor.adapter.insertAfter(id("a"), "/"))).toBe(true);
    expect(editor.blocks().map((block) => block.id)).toEqual(["a", "new-1", "b"]);
    expect(editor.state.selection.$from.parent.textContent).toBe("/");
    expect(editor.state.selection.$from.parentOffset).toBe(1);
  });

  it("splits list item bodies with no duplicate IDs and reparents loaded descendants in the same transaction", () => {
    const blocks = [
      paragraph("a", "abcd", { type: "bulleted_item" }),
      paragraph("b", "nested", { parentId: id("a") }),
      paragraph("c", "next child", { parentId: id("a") }),
      paragraph("z", "next root"),
    ];
    const editor = setup(blocks, {
      allocateOrder: ({ parentId, before, after }) =>
        `${parentId ?? "root"}:${before ?? "start"}:${after ?? "end"}`,
    });
    editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 4)));
    expect(editor.run(editor.adapter.split())).toBe(true);
    expect(editor.blocks().map((block) => [block.id, block.parentId])).toEqual([
      ["a", null],
      ["new-1", null],
      ["b", "new-1"],
      ["c", "new-1"],
      ["z", null],
    ]);
    const firstSplit = editor.blocks();
    let childPos = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.attrs.block?.id === "b") childPos = pos;
    });
    editor.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, childPos + 4)),
    );
    expect(editor.run(editor.adapter.split())).toBe(true);
    expect(editor.blocks()).toEqual([
      paragraph("a", "ab", { type: "bulleted_item" }),
      paragraph("new-1", "cd", { type: "bulleted_item", order: "root:a:z" }),
      paragraph("b", "nes", { parentId: id("new-1") }),
      paragraph("new-2", "ted", { parentId: id("new-1"), order: "new-1:b:c" }),
      { ...blocks[2], parentId: id("new-1") },
      blocks[3],
    ]);
    const secondSplit = editor.blocks();
    expect(editor.run(editor.adapter.undoLocal())).toBe(true);
    expect(editor.blocks()).toEqual(firstSplit);
    expect(editor.run(editor.adapter.redoLocal())).toBe(true);
    expect(editor.blocks()).toEqual(secondSplit);
    expect(editor.run(editor.adapter.undoLocal())).toBe(true);
    expect(editor.run(editor.adapter.undoLocal())).toBe(true);
    expect(editor.blocks()).toEqual(blocks);
  });

  it("pastes a fresh complete subtree and remaps internal mentions without trusting clipboard IDs", () => {
    const input = [
      paragraph("a", "parent", { type: "bulleted_item" }),
      paragraph("b", "", {
        parentId: id("a"),
        content: {
          runs: [
            {
              text: "ref",
              marks: [
                { type: "block_mention", version: 1, target: { ...target, blockId: id("a") } },
              ],
            },
          ],
        },
      }),
    ];
    const editor = setup(input);
    const clipboard = editor.adapter.copyBlocks(editor.state, [id("a")]);
    expect(editor.run(editor.adapter.pasteBlocks(clipboard, target))).toBe(true);
    const pasted = editor.blocks().slice(2);
    expect(pasted).toMatchObject([
      { id: "new-1", parentId: null, type: "bulleted_item" },
      {
        id: "new-2",
        parentId: "new-1",
        content: { runs: [{ text: "ref", marks: [{ target: { blockId: "new-1" } }] }] },
      },
    ]);
    expect(editor.run(editor.adapter.undoLocal())).toBe(true);
    expect(editor.blocks()).toEqual(input);
    expect(editor.run(editor.adapter.redoLocal())).toBe(true);
    expect(editor.blocks().map((block) => block.id)).toEqual(["a", "b", "new-1", "new-2"]);
  });

  it("rejects opaque and child-page clipboard content and IDs that collide with loaded blocks", () => {
    const editor = setup([paragraph("a", "safe")]);
    for (const block of [
      paragraph("x", "", { type: "child_page", content: { pageId: "child" } }),
      paragraph("y", "", {
        content: { runs: [{ text: "unknown", marks: [{ type: "new-mark", version: 1 }] }] },
      }),
      paragraph("z", "", {
        content: {
          runs: [
            {
              text: "duplicate marks",
              marks: [
                { type: "bold", version: 1 },
                { type: "bold", version: 1 },
              ],
            },
          ],
        },
      }),
    ]) {
      expect(editor.run(editor.adapter.pasteBlocks([block], target))).toBe(false);
      const source = setup([block]);
      expect(() => source.adapter.copyBlocks(source.state, [block.id])).toThrow();
    }
    expect(
      editor.run(
        editor.adapter.pasteBlocks([paragraph("x", "copy")], {
          ...target,
          pageId: SpacePageId.make("another-page"),
        }),
      ),
    ).toBe(false);
    const collision = setup([paragraph("a", "safe")], { allocateId: () => id("a") });
    expect(collision.run(collision.adapter.pasteBlocks([paragraph("x", "copy")], target))).toBe(
      false,
    );
    expect(editor.blocks()).toEqual([paragraph("a", "safe")]);
  });

  it.each([id("unloaded-parent"), null])(
    "edits a partial window under %s without inferring deletes, and refuses structural operations over unknown boundaries",
    (parentId) => {
      const blocks = [
        paragraph("b", "loaded", { parentId }),
        paragraph("d", "later", { parentId }),
      ];
      const editor = setup(blocks, { window: { revision: 88, blocks, completeParents: [] } });
      editor.dispatch(editor.state.tr.insertText("!", 2));
      expect(editor.adapter.batch(editor.state)).toMatchObject({
        baseRevision: 88,
        memberIds: ["b", "d"],
        mutations: [{ kind: "replace", block: { id: "b", parentId } }],
      });
      editor.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, editor.state.doc.firstChild!.nodeSize + 1),
        ),
      );
      expect(editor.run(editor.adapter.joinBackward())).toBe(false);
      expect(editor.run(editor.adapter.split())).toBe(false);
      expect(editor.run(editor.adapter.move(id("d"), null))).toBe(false);
      editor.dispatch(editor.state.tr.delete(0, editor.state.doc.firstChild!.nodeSize));
      expect(editor.blocks().map((block) => block.id)).toEqual(["b", "d"]);
      expect(
        editor.adapter
          .batch(editor.state)
          .mutations.every((mutation) => mutation.kind !== "delete"),
      ).toBe(true);
    },
  );

  it("blocks generic duplicate-ID split, cross-block replacement, cycles, incomplete subtree copy, and oversized paste", () => {
    const blocks = [
      paragraph("a", "list", { type: "bulleted_item" }),
      paragraph("b", "child", { parentId: id("a") }),
    ];
    const editor = setup(blocks, { window: { revision: 17, blocks, completeParents: [null] } });
    editor.dispatch(editor.state.tr.split(3, 2));
    expect(editor.blocks()).toEqual(blocks);
    expect(editor.run(editor.adapter.move(id("a"), id("a")))).toBe(false);
    expect(() => editor.adapter.copyBlocks(editor.state, [id("a")])).toThrow(
      "complete loaded subtrees",
    );
    editor.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)).deleteSelection(),
    );
    expect(editor.blocks()).toEqual(blocks);
    const small = setup([paragraph("a", "safe")], { maxClipboardBytes: 10 });
    expect(small.run(small.adapter.pasteBlocks([paragraph("b", "large")], target))).toBe(false);
  });
});

it.each(["envelope", "content", "run", "mark", "duplicate-mark"] as const)(
  "refuses media editing without stripping unsupported %s data",
  (rest) => {
    const caption = [{ text: "caption", marks: [{ type: "bold", version: 1 }] }];
    const base = paragraph("media", "", {
      type: "image",
      content: { assetId: "asset-before", caption },
    });
    const block: SpaceBlock =
      rest === "envelope"
        ? { ...base, opaque: { future: true } }
        : rest === "content"
          ? { ...base, content: { assetId: "asset-before", caption, crop: [1, 2] } }
          : rest === "run"
            ? {
                ...base,
                content: {
                  assetId: "asset-before",
                  caption: [{ ...caption[0], language: "opaque" }],
                },
              }
            : {
                ...base,
                content: {
                  assetId: "asset-before",
                  caption: [
                    {
                      text: "caption",
                      marks:
                        rest === "mark"
                          ? [
                              {
                                type: "link",
                                version: 1,
                                href: "https://example.test",
                                future: true,
                              },
                            ]
                          : [
                              { type: "bold", version: 1 },
                              { type: "bold", version: 1 },
                            ],
                    },
                  ],
                },
              };
    const editor = setup([block], { canEditMedia: () => true });
    expect(editor.state.doc.firstChild!.type.name).toBe("spaceAtom");
    expect(editor.run(editor.adapter.removeMedia(block.id))).toBe(false);
    expect(
      editor.run(editor.adapter.replaceMedia(block, { ...base, content: { assetId: "new" } })),
    ).toBe(false);
    editor.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { block: base }));
    expect(editor.blocks()).toEqual([block]);
    expect(editor.run(editor.adapter.undoLocal())).toBe(false);
  },
);
