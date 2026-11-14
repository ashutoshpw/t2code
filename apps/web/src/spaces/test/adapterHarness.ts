import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection, type Command, type Transaction } from "@tiptap/pm/state";
import { spaceBlockHoldsChildren } from "@t2code/client-runtime/spaces";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceBlockId, SpacePageId, type SpaceBlock } from "@t2code/contracts/spaces";

import { SpaceEditorAdapter, type SpaceEditorOptions } from "../adapter";
import { spaceDocumentBlocks } from "../document";

export const id = SpaceBlockId.make;
export const target = {
  environmentId: EnvironmentId.make("env"),
  pageId: SpacePageId.make("page"),
};
export function paragraph(key: string, text: string, extra: Partial<SpaceBlock> = {}): SpaceBlock {
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
export function setup(blocks: readonly SpaceBlock[], overrides: Partial<SpaceEditorOptions> = {}) {
  let sequence = 0;
  const adapter = new SpaceEditorAdapter({
    target,
    window: {
      revision: 17,
      blocks,
      completeParents: [
        null,
        ...blocks.filter((block) => spaceBlockHoldsChildren(block)).map((block) => block.id),
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

const tab = (key: string, extra: Partial<SpaceBlock>): SpaceBlock => ({
  id: id(key),
  parentId: null,
  order: key,
  type: "tabs",
  version: 1,
  content: {},
  ...extra,
});

/** A tabs block with two panes, one paragraph in each, then a root paragraph. */
export const tabsBlocks = (): SpaceBlock[] => [
  tab("t", {}),
  tab("p1", { parentId: id("t"), type: "tab_pane", content: { title: "One" } }),
  paragraph("a", "alpha", { parentId: id("p1") }),
  tab("p2", { parentId: id("t"), type: "tab_pane", content: { title: "Two" }, order: "p2" }),
  paragraph("b", "beta", { parentId: id("p2") }),
  paragraph("z", "tail"),
];

export function caretIn(harness: ReturnType<typeof setup>, blockId: string) {
  let found = -1;
  harness.state.doc.descendants((node, pos) => {
    if ((node.attrs.block as SpaceBlock | undefined)?.id === blockId) found = pos;
    return found < 0;
  });
  harness.dispatch(
    harness.state.tr.setSelection(TextSelection.near(harness.state.doc.resolve(found + 1))),
  );
}

const synced = (key: string, extra: Partial<SpaceBlock>): SpaceBlock => ({
  id: id(key),
  parentId: null,
  order: key,
  type: "synced_block",
  version: 1,
  content: {},
  ...extra,
});

/** An original with one paragraph, a root paragraph, and a copy of the original. */
export const syncedBlocks = (): SpaceBlock[] => [
  synced("s", {}),
  paragraph("sa", "inside", { parentId: id("s") }),
  paragraph("z", "tail", { order: "z" }),
  synced("r", {
    type: "synced_ref",
    order: "zz",
    content: { sourceBlockId: id("s") },
  }),
];
