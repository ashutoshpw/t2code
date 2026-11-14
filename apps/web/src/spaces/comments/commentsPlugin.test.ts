import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { SpaceBlockId } from "@t2code/contracts/spaces";
import {
  SpaceCommentId,
  SpaceCommentThreadId,
  type SpaceCommentThread,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { id, paragraph, setup } from "../test/adapterHarness";
import {
  spaceCommentsPlugin,
  spaceCommentsRefresh,
  spaceCommentTarget,
  type SpaceCommentSource,
} from "./commentsPlugin";

const now = "2026-11-14T00:00:00.000Z";
const thread = (
  key: string,
  blockId: string,
  anchor: SpaceCommentThread["anchor"],
): SpaceCommentThread => ({
  id: SpaceCommentThreadId.make(key),
  pageId: "page" as SpaceCommentThread["pageId"],
  blockId: SpaceBlockId.make(blockId),
  resolvedBlockId: SpaceBlockId.make(blockId),
  anchorState: "live",
  anchor,
  status: "open",
  resolvedAt: null,
  createdAt: now,
  revision: 1 as SpaceCommentThread["revision"],
  comments: [
    {
      id: SpaceCommentId.make(`${key}-c`),
      author: { kind: "user" },
      body: [{ text: "note", marks: [] }],
      createdAt: now,
      editedAt: null,
    },
  ],
});
const range = (quote: string, text: string): SpaceCommentThread["anchor"] => {
  const start = text.indexOf(quote);
  return {
    kind: "range",
    quote,
    prefix: text.slice(Math.max(0, start - 32), start),
    suffix: text.slice(start + quote.length, start + quote.length + 32),
    start,
    end: start + quote.length,
  };
};

function fixture(threads: SpaceCommentThread[]) {
  const harness = setup([paragraph("a", "alpha beta gamma"), paragraph("b", "second")]);
  const source: SpaceCommentSource = {
    threads: () => threads,
    activeThreadId: () => null,
    open: () => {},
    compose: () => {},
    enabled: () => true,
  };
  let state = EditorState.create({
    doc: harness.state.doc,
    plugins: [...harness.adapter.plugins(), spaceCommentsPlugin(source)],
  });
  const plugin = state.plugins.at(-1)!;
  const decorations = () =>
    (plugin.getState(state) as { decorations: DecorationSet }).decorations.find();
  const inline = () => decorations().filter((entry) => entry.from !== entry.to);
  const bubbles = () => decorations().filter((entry) => entry.from === entry.to);
  return {
    harness,
    get state() {
      return state;
    },
    set state(next: EditorState) {
      state = next;
    },
    decorations,
    inline,
    bubbles,
    source,
  };
}

describe("spaceCommentsPlugin", () => {
  const text = "alpha beta gamma";
  const threads = [thread("t1", "a", range("beta", text))];

  it("keeps the range through a state recreation and maps it through typing", () => {
    const f = fixture(threads);
    expect(f.inline().map((entry) => [entry.from, entry.to])).toEqual([[7, 11]]);
    f.state = EditorState.create({
      doc: f.state.doc,
      selection: f.state.selection,
      plugins: f.state.plugins,
    });
    expect(f.inline()).toHaveLength(1);
    f.state = f.state.apply(f.state.tr.insertText("xx", 1));
    expect(f.inline().map((entry) => [entry.from, entry.to])).toEqual([[9, 13]]);
  });

  it("drops the inline mark once the quote is gone but keeps the block bubble", () => {
    const f = fixture(threads);
    f.state = f.state.apply(f.state.tr.delete(7, 11));
    f.state = f.state.apply(spaceCommentsRefresh(f.state.tr));
    expect(f.inline()).toHaveLength(0);
    expect(f.bubbles()).toHaveLength(1);
  });

  it("counts every open thread of a block in one bubble", () => {
    const f = fixture([...threads, thread("t2", "a", { kind: "block" })]);
    expect(f.bubbles()).toHaveLength(1);
    expect(String(f.bubbles()[0]!.spec.key)).toBe("a:2:false");
  });

  it("targets a range inside one block and falls back to the block across blocks", () => {
    const f = fixture([]);
    const doc = f.state.doc;
    const inOne = f.state.apply(f.state.tr.setSelection(TextSelection.create(doc, 7, 11)));
    expect(spaceCommentTarget(inOne)).toMatchObject({
      blockId: id("a"),
      anchor: { kind: "range", quote: "beta", start: 6, end: 10 },
    });
    const across = f.state.apply(f.state.tr.setSelection(TextSelection.create(doc, 7, 24)));
    expect(spaceCommentTarget(across)).toEqual({ blockId: id("b"), anchor: { kind: "block" } });
  });
});
