import { describe, expect, it } from "vite-plus/test";
import { EditorState, TextSelection, type Command, type Transaction } from "@tiptap/pm/state";
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
