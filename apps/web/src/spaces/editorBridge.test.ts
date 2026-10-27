import { describe, expect, it } from "vite-plus/test";
import {
  EditorState,
  NodeSelection,
  TextSelection,
  type Command,
  type Transaction,
} from "@tiptap/pm/state";
import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceBlockId,
  SpacePageId,
  SpaceId,
  SpaceReceiptEpoch,
  type SpaceBlock,
} from "@t2code/contracts/spaces";
import { SpaceDocumentController } from "./documentController";
import { SpaceEditorBridge } from "./editorBridge";
import { spaceDocumentBlocks } from "./document";

const key = { environmentId: EnvironmentId.make("editor"), pageId: SpacePageId.make("page") };
function paragraph(
  id: string,
  text: string,
  order = "40000000000000000000000000000000",
): SpaceBlock {
  return {
    id: SpaceBlockId.make(id),
    parentId: null,
    order,
    type: "paragraph",
    version: 1,
    content: { runs: [{ text, marks: [] }] },
  };
}
async function model(blocks: readonly SpaceBlock[], partial = false) {
  const now = "2026-10-26T00:00:00.000Z";
  const spaceId = SpaceId.make("space");
  const controller = new SpaceDocumentController(
    key,
    {
      adapter: {
        getMutationAdmission: async () => {
          throw new Error("No backend in model test");
        },
        save: async () => {
          throw new Error("No backend in model test");
        },
        lookupReceipt: async () => {
          throw new Error("No backend in model test");
        },
      },
      drafts: { load: async () => null, write: async () => {} },
      createMutationId: () => "unused",
      maxLoadedBlocks: 100,
      maxMutations: 100,
    },
    {
      getPage: async () => ({
        page: {
          id: key.pageId,
          spaceId,
          title: "Page",
          revision: 1,
          rootOrder: "1",
          createdAt: now,
          updatedAt: now,
        },
        space: {
          id: spaceId,
          title: "Space",
          revision: 1,
          rootOrderRevision: 1,
          isDefault: true,
          createdAt: now,
          updatedAt: now,
        },
        mutationAdmission: {
          epoch: SpaceReceiptEpoch.make("unused"),
          acceptsUntil: now,
          retainUntil: now,
        },
      }),
      readBlocks: async () => ({
        revision: 1,
        blocks,
        nextCursor: partial
          ? ("continuation" as import("@t2code/contracts/spaces").SpaceCursor)
          : null,
      }),
      windowLimit: () => 100,
    },
  );
  await controller.open();
  let ids = 0;
  const bridge = new SpaceEditorBridge(controller, () => SpaceBlockId.make(`fresh-${++ids}`));
  bridge.setWritable(true);
  let state = EditorState.create({
    doc: bridge.adapter.document,
    plugins: bridge.adapter.plugins(),
  });
  return {
    controller,
    bridge,
    get state() {
      return state;
    },
    dispatch: (tr: Transaction) => {
      state = bridge.apply(state, tr).state;
    },
    run(command: Command) {
      return command(state, (tr) => {
        state = bridge.apply(state, tr).state;
      });
    },
    synchronize() {
      state = bridge.synchronize(state);
    },
  };
}
function position(state: EditorState, id: string, offset = 0) {
  let result = -1;
  state.doc.descendants((node, pos) => {
    if (node.attrs.block?.id === id) result = pos + 1 + offset;
  });
  return result;
}

describe("Production Spaces command bridge", () => {
  it("creates real editable text in an empty complete page with a fixed-width rank", async () => {
    const view = await model([]);
    expect(view.run(view.bridge.adapter.append())).toBe(true);
    expect(view.state.selection.$from.parent.isTextblock).toBe(true);
    view.dispatch(view.state.tr.insertText("Hello"));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
    expect(view.run(view.bridge.adapter.mark("bold"))).toBe(true);
    expect(view.controller.session.getSnapshot().blocks).toEqual([
      {
        ...paragraph("fresh-1", "Hello", "7fffffffffffffffffffffffffffffff"),
        content: { runs: [{ text: "Hello", marks: [{ type: "bold", version: 1 }] }] },
      },
    ]);
    await view.controller.session.persistDraft();
  });
  it("propagates ordered splits and edits between views without echo and preserves the other selection", async () => {
    const view = await model([
      paragraph("a", "hello"),
      paragraph("b", "world", "c0000000000000000000000000000000"),
    ]);
    const peer = new SpaceEditorBridge(view.controller, () => SpaceBlockId.make("peer-new"));
    peer.setWritable(true);
    let peerState = EditorState.create({
      doc: peer.adapter.document,
      plugins: peer.adapter.plugins(),
    });
    peerState = peerState.apply(
      peerState.tr.setSelection(TextSelection.create(peerState.doc, position(peerState, "b", 2))),
    );
    const unsubscribe = view.controller.subscribe(() => {
      peerState = peer.synchronize(peerState);
    });
    try {
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, position(view.state, "a", 2)),
        ),
      );
      expect(view.run(view.bridge.adapter.split())).toBe(true);
      expect(view.controller.session.getSnapshot().generation).toBe(1);
      expect(view.controller.session.getSnapshot().blocks.map((block) => block.id)).toEqual([
        "a",
        "fresh-1",
        "b",
      ]);
      expect(spaceDocumentBlocks(peerState.doc).map((block) => block.id)).toEqual([
        "a",
        "fresh-1",
        "b",
      ]);
      expect(peerState.selection.$from.parent.attrs.block.id).toBe("b");
      expect(peerState.selection.$from.parentOffset).toBe(2);
      peerState = peer.apply(peerState, peerState.tr.insertText("!")).state;
      view.synchronize();
      expect(view.controller.session.getSnapshot().generation).toBe(2);
      expect(spaceDocumentBlocks(view.state.doc).map((block) => block.id)).toEqual([
        "a",
        "fresh-1",
        "b",
      ]);
      expect(view.run(view.bridge.adapter.undoLocal())).toBe(false);
      expect(view.bridge.getSnapshot()).toContain("Another view");
    } finally {
      unsubscribe();
    }
    await view.controller.session.persistDraft();
  });
  it("preserves split/join identities through local undo and redo before acknowledgement", async () => {
    const view = await model([paragraph("a", "hello")]);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    view.run(view.bridge.adapter.split());
    expect(view.run(view.bridge.adapter.undoLocal())).toBe(true);
    expect(spaceDocumentBlocks(view.state.doc)).toEqual([paragraph("a", "hello")]);
    expect(view.run(view.bridge.adapter.redoLocal())).toBe(true);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, position(view.state, "fresh-1")),
      ),
    );
    expect(view.run(view.bridge.adapter.joinBackward())).toBe(true);
    expect(view.run(view.bridge.adapter.undoLocal())).toBe(true);
    expect(spaceDocumentBlocks(view.state.doc).map((block) => block.id)).toEqual(["a", "fresh-1"]);
    expect(view.run(view.bridge.adapter.redoLocal())).toBe(true);
    expect(spaceDocumentBlocks(view.state.doc)).toEqual([
      {
        ...paragraph("a", "hello"),
        content: {
          runs: [
            { text: "he", marks: [] },
            { text: "llo", marks: [] },
          ],
        },
      },
    ]);
    await view.controller.session.persistDraft();
  });
  it("keeps opaque and unloaded content safe while refusing partial-window structure and revoked editing", async () => {
    const opaque = {
      ...paragraph("future", ""),
      type: "future",
      version: 8,
      content: { untouched: ["opaque", false] },
    };
    const unknownMark = {
      ...paragraph("marked", ""),
      content: { runs: [{ text: "keep", marks: [{ type: "future", version: 4 }] }] },
    };
    const view = await model([opaque, unknownMark, paragraph("a", "editable")], true);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, position(view.state, "a", 1)),
      ),
    );
    expect(view.run(view.bridge.adapter.split())).toBe(false);
    expect(view.run(view.bridge.adapter.append())).toBe(false);
    view.dispatch(view.state.tr.insertText("!"));
    expect(view.controller.session.getSnapshot().blocks.slice(0, 2)).toEqual([opaque, unknownMark]);
    expect(() =>
      view.controller.session.apply([{ kind: "delete", blockId: SpaceBlockId.make("unloaded") }]),
    ).toThrow("unloaded");
    const before = view.state;
    view.bridge.setWritable(false);
    view.dispatch(view.state.tr.insertText("denied"));
    expect(view.state).toBe(before);
    await view.controller.session.persistDraft();
  });
  describe.each(["image", "pdf", "video"] as const)("%s structured clipboard", (type) => {
    it.each([false, true])(
      "refuses the whole media payload without changing the draft or prior history (nested: %s)",
      async (nested) => {
        const list = {
          ...paragraph("list", "", "c0000000000000000000000000000000"),
          type: "bulleted_item",
          content: { runs: [{ text: "parent", marks: [] }] },
        };
        const childList = { ...list, id: SpaceBlockId.make("child-list"), parentId: list.id };
        const media = {
          ...paragraph("media", "", "c0000000000000000000000000000000"),
          parentId: nested ? childList.id : null,
          type,
          content: { assetId: "existing-asset", caption: [{ text: "keep", marks: [] }] },
        };
        const blocks = [
          paragraph("a", "original"),
          paragraph("copy", "clipboard text", "80000000000000000000000000000000"),
          ...(nested ? [list, childList] : []),
          media,
        ];
        const view = await model(blocks);
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, position(view.state, "a", 1)),
          ),
        );
        view.dispatch(view.state.tr.insertText("!"));
        await view.controller.session.persistDraft();
        const clipboard = view.bridge.adapter.copyBlocks(view.state, [
          SpaceBlockId.make("copy"),
          nested ? list.id : media.id,
        ]);
        expect(clipboard.some((block) => block.type === type)).toBe(true);
        const beforeEditor = view.state;
        const beforeSession = view.controller.session.getSnapshot();
        expect(beforeSession.dirty).toBe(true);
        expect(view.run(view.bridge.adapter.pasteBlocks(clipboard, key))).toBe(false);
        expect(view.state).toBe(beforeEditor);
        expect(view.controller.session.getSnapshot()).toBe(beforeSession);
        view.synchronize();
        expect(view.run(view.bridge.adapter.undoLocal())).toBe(true);
        expect(spaceDocumentBlocks(view.state.doc)).toEqual(blocks);
        expect(view.controller.session.getSnapshot().blocks).toEqual(blocks);
        expect(view.run(view.bridge.adapter.redoLocal())).toBe(true);
        expect(view.controller.session.getSnapshot().blocks).toEqual(beforeSession.blocks);
        await view.controller.session.persistDraft();
      },
    );
  });
  it("edits known list/code content and refuses to delete opaque descendants", async () => {
    const todo = {
      ...paragraph("a", ""),
      type: "todo_item",
      content: { checked: false, runs: [{ text: "list", marks: [] }] },
    };
    const child = { ...paragraph("child", "nested"), parentId: SpaceBlockId.make("a") };
    const code = {
      ...paragraph("code", "", "c0000000000000000000000000000000"),
      type: "code",
      content: { text: "source", language: "ts" },
    };
    const view = await model([todo, child, code]);
    expect(view.run(view.bridge.adapter.toggleTodo(todo.id))).toBe(true);
    expect(view.controller.session.getSnapshot().blocks[0]?.content).toEqual({
      ...todo.content,
      checked: true,
    });
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, position(view.state, "child", 2)),
      ),
    );
    expect(view.run(view.bridge.adapter.split())).toBe(true);
    expect(
      view.controller.session.getSnapshot().blocks.map((block) => [block.id, block.parentId]),
    ).toEqual([
      ["a", null],
      ["child", "a"],
      ["fresh-1", "a"],
      ["code", null],
    ]);
    expect(view.run(view.bridge.adapter.undoLocal())).toBe(true);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, position(view.state, "code", 1)),
      ),
    );
    view.dispatch(view.state.tr.insertText("!"));
    expect(view.controller.session.getSnapshot().blocks.at(-1)?.content).toEqual({
      ...code.content,
      text: "s!ource",
    });
    expect(view.run(view.bridge.adapter.remove(todo.id))).toBe(true);
    expect(view.controller.session.getSnapshot().blocks.map((block) => block.id)).toEqual(["code"]);
    await view.controller.session.persistDraft();
    const opaque = {
      ...paragraph("opaque", ""),
      type: "future",
      version: 9,
      content: { untouched: true },
    };
    const protectedView = await model([opaque, { ...child, parentId: opaque.id }]);
    expect(protectedView.run(protectedView.bridge.adapter.remove(opaque.id))).toBe(false);
    expect(protectedView.run(protectedView.bridge.adapter.remove(child.id))).toBe(false);
    expect(protectedView.controller.session.getSnapshot().dirty).toBe(false);
  });
  it("refuses exhausted or invalid rank gaps without renumbering existing blocks", async () => {
    const available = await model([
      paragraph("a", "first", "00000000000000000000000000000001"),
      paragraph("b", "second", "00000000000000000000000000000003"),
    ]);
    available.dispatch(
      available.state.tr.setSelection(TextSelection.create(available.state.doc, 2)),
    );
    expect(available.run(available.bridge.adapter.split())).toBe(true);
    expect(available.controller.session.getSnapshot().blocks.map((block) => block.order)).toEqual([
      "00000000000000000000000000000001",
      "00000000000000000000000000000002",
      "00000000000000000000000000000003",
    ]);
    await available.controller.session.persistDraft();
    for (const rank of ["prototype", "ffffffffffffffffffffffffffffffff"]) {
      const refused = await model([paragraph("a", "first", rank)]);
      expect(refused.run(refused.bridge.adapter.append())).toBe(false);
      expect(refused.controller.session.getSnapshot().blocks).toEqual([
        paragraph("a", "first", rank),
      ]);
      expect(refused.controller.session.getSnapshot().dirty).toBe(false);
    }
    const view = await model([
      paragraph("a", "first", "00000000000000000000000000000001"),
      paragraph("b", "second", "00000000000000000000000000000002"),
    ]);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    const before = view.state;
    expect(view.run(view.bridge.adapter.split())).toBe(false);
    expect(view.state).toBe(before);
    expect(view.controller.session.getSnapshot().generation).toBe(0);
  });
});

describe("Current-selection Spaces formatting", () => {
  it("changes only canonical heading, callout and language attributes and preserves complete rich runs through local undo", async () => {
    const runs = [
      { text: "", marks: [] },
      {
        text: "kept",
        marks: [
          { type: "bold", version: 1 },
          { type: "page_mention", version: 1, target: key },
        ],
      },
    ];
    const blocks = [
      { ...paragraph("h", ""), type: "heading", content: { level: 1, runs } },
      {
        ...paragraph("c", "", "80000000000000000000000000000000"),
        type: "callout",
        content: { icon: "💡", runs },
      },
      {
        ...paragraph("code", "", "c0000000000000000000000000000000"),
        type: "code",
        content: { text: "const x = 1;", language: "future-language" },
      },
    ];
    const view = await model(blocks, true);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, position(view.state, "h"))),
    );
    expect(view.run(view.bridge.adapter.setHeadingLevel(2))).toBe(true);
    expect(view.run(view.bridge.adapter.setHeadingLevel(3))).toBe(true);
    expect(view.controller.session.getSnapshot().blocks[0]).toEqual({
      ...blocks[0],
      content: { level: 3, runs },
    });
    expect(view.run(view.bridge.adapter.undoLocal())).toBe(true);
    expect(view.controller.session.getSnapshot().blocks[0]).toEqual({
      ...blocks[0],
      content: { level: 2, runs },
    });
    expect(view.run(view.bridge.adapter.undoLocal())).toBe(true);
    expect(view.controller.session.getSnapshot().blocks).toEqual(blocks);
    expect(view.run(view.bridge.adapter.redoLocal())).toBe(true);
    expect(view.run(view.bridge.adapter.redoLocal())).toBe(true);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, position(view.state, "c"))),
    );
    expect(view.run(view.bridge.adapter.setCalloutIcon("📌"))).toBe(true);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, position(view.state, "code")),
      ),
    );
    expect(view.run(view.bridge.adapter.setCodeLanguage("typescript"))).toBe(true);
    expect(view.controller.session.getSnapshot().blocks).toEqual([
      { ...blocks[0], content: { level: 3, runs } },
      { ...blocks[1], content: { icon: "📌", runs } },
      { ...blocks[2], content: { text: "const x = 1;", language: "typescript" } },
    ]);
    expect(view.controller.session.getSnapshot().dirty).toBe(true);
  });

  it("creates, edits and removes one link without flattening combined marks, mention targets or empty runs", async () => {
    const bold = { type: "bold", version: 1 },
      mention = { type: "page_mention", version: 1, target: key };
    const runs = [
      { text: "", marks: [] },
      { text: "ab", marks: [bold, mention] },
      { text: "cd", marks: [mention] },
      { text: "tail", marks: [] },
    ];
    const view = await model([{ ...paragraph("a", ""), content: { runs } }]);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
    expect(view.run(view.bridge.adapter.setLink("https://example.test/one"))).toBe(true);
    const link = { type: "link", version: 1, href: "https://example.test/one" };
    expect(view.controller.session.getSnapshot().blocks[0]!.content).toEqual({
      runs: [
        runs[0],
        { text: "ab", marks: [bold, mention, link] },
        { text: "cd", marks: [mention, link] },
        runs[3],
      ],
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    expect(view.bridge.adapter.linkSelection(view.state)).toMatchObject({
      from: 1,
      to: 5,
      href: link.href,
      hasLink: true,
    });
    expect(view.run(view.bridge.adapter.setLink("mailto:hello@example.test"))).toBe(true);
    expect(view.run(view.bridge.adapter.removeLink())).toBe(true);
    expect(view.controller.session.getSnapshot().blocks[0]!.content).toEqual({ runs });
    expect(view.run(view.bridge.adapter.undoLocal())).toBe(true);
    expect(view.controller.session.getSnapshot().blocks[0]!.content).toEqual({
      runs: [
        runs[0],
        { text: "ab", marks: [bold, mention, { ...link, href: "mailto:hello@example.test" }] },
        { text: "cd", marks: [mention, { ...link, href: "mailto:hello@example.test" }] },
        runs[3],
      ],
    });
  });
});

it("refuses unsafe links, readonly attributes and unknown payloads without changing either shared state", async () => {
  const unknown = {
    ...paragraph("unknown", ""),
    type: "heading",
    content: {
      level: 2,
      runs: [{ text: "opaque", marks: [{ type: "future", version: 3, exact: { kept: true } }] }],
    },
  };
  const rest = {
    ...paragraph("rest", "", "80000000000000000000000000000000"),
    content: { runs: [{ text: "retained", marks: [], future: [1, 2] }] },
  };
  const view = await model([
    {
      ...paragraph("h", "text"),
      type: "heading",
      content: { level: 1, runs: [{ text: "text", marks: [] }] },
    },
    unknown,
    rest,
  ]);
  const before = view.controller.session.getSnapshot(),
    doc = view.state.doc;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
  for (const href of ["javascript:alert(1)", "data:text/html,evil", "/relative", ""]) {
    expect(view.run(view.bridge.adapter.setLink(href))).toBe(false);
  }
  expect(view.run(view.bridge.adapter.setHeadingLevel(4 as 1))).toBe(false);
  view.bridge.setWritable(false);
  expect(view.run(view.bridge.adapter.setHeadingLevel(2))).toBe(false);
  expect(view.run(view.bridge.adapter.setLink("https://example.test"))).toBe(false);
  view.bridge.setWritable(true);
  expect(view.state.doc.eq(doc)).toBe(true);
  expect(view.controller.session.getSnapshot()).toBe(before);
  view.dispatch(
    view.state.tr.setSelection(
      NodeSelection.create(view.state.doc, view.state.doc.child(0).nodeSize),
    ),
  );
  expect(view.run(view.bridge.adapter.setHeadingLevel(3))).toBe(false);
  expect(view.run(view.bridge.adapter.setLink("https://example.test"))).toBe(false);
  expect(view.controller.session.getSnapshot().blocks).toEqual(before.blocks);
});

it("limits link changes to one rich body and refuses empty insertion, code and surrogate-interior targets", async () => {
  const a = paragraph("a", "a😀bc"),
    b = paragraph("b", "other", "80000000000000000000000000000000");
  const code = {
    ...paragraph("code", "", "c0000000000000000000000000000000"),
    type: "code",
    content: { text: "source", language: "ts" },
  };
  const view = await model([a, b, code]);
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, position(view.state, "code"))),
  );
  expect(view.run(view.bridge.adapter.setLink("https://example.test"))).toBe(false);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
  expect(view.run(view.bridge.adapter.setLink("https://example.test"))).toBe(false);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 5)));
  expect(view.run(view.bridge.adapter.setLink("https://example.test"))).toBe(false);
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, 1, position(view.state, "b", 2)),
    ),
  );
  expect(view.run(view.bridge.adapter.setLink("https://example.test"))).toBe(false);
  expect(view.controller.session.getSnapshot().blocks).toEqual([a, b, code]);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4, 6)));
  expect(view.run(view.bridge.adapter.setLink("http://example.test/path"))).toBe(true);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
  expect(view.bridge.adapter.linkSelection(view.state)).toMatchObject({
    href: null,
    hasLink: true,
  });
  expect(view.run(view.bridge.adapter.removeLink())).toBe(true);
  expect(view.state.doc.textContent).toBe("a😀bcothersource");
  expect(view.controller.session.getSnapshot().blocks[1]).toEqual(b);
});

it("changes only a partial list body's link while preserving its opaque loaded descendant", async () => {
  const list = { ...paragraph("list", "list text"), type: "bulleted_item" };
  const child = {
    ...paragraph("opaque", "", "80000000000000000000000000000000"),
    parentId: list.id,
    type: "future_widget",
    version: 9,
    content: { exact: ["retained", { value: true }] },
    future: { kept: 1 },
  };
  const view = await model([list, child], true);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 6)));
  expect(view.run(view.bridge.adapter.setLink("https://example.test/list"))).toBe(true);
  expect(view.controller.session.getSnapshot().blocks).toEqual([
    {
      ...list,
      content: {
        runs: [
          {
            text: "list",
            marks: [{ type: "link", version: 1, href: "https://example.test/list" }],
          },
          { text: " text", marks: [] },
        ],
      },
    },
    child,
  ]);
  expect(view.run(view.bridge.adapter.undoLocal())).toBe(true);
  expect(view.controller.session.getSnapshot().blocks).toEqual([list, child]);
  expect(view.run(view.bridge.adapter.redoLocal())).toBe(true);
  expect(view.controller.session.getSnapshot().blocks[1]).toEqual(child);
});
