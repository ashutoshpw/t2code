import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it, vi } from "vite-plus/test";

import { updateAtomNodeView } from "./nodeView";

const node = (block: unknown) => ({ attrs: { block } }) as unknown as ProseMirrorNode;
const database = (id: string) => ({
  id,
  parentId: null,
  order: "a",
  type: "database",
  version: 1,
  content: { databaseId: "d", viewIds: [] },
});
const divider = { id: "x", parentId: null, order: "a", type: "divider", version: 1, content: {} };

describe("updateAtomNodeView", () => {
  it("rebuilds the view when a database and a plain atom swap, or when the block changes", () => {
    const updateProps = vi.fn();
    const call = (oldNode: ProseMirrorNode, newNode: ProseMirrorNode) =>
      updateAtomNodeView({ oldNode, newNode, updateProps });
    expect(call(node(divider), node(database("a")))).toBe(false);
    expect(call(node(database("a")), node(divider))).toBe(false);
    expect(call(node(database("a")), node(database("b")))).toBe(false);
    expect(updateProps).not.toHaveBeenCalled();
  });

  it("updates in place for the same kind and only re-renders when the node changed", () => {
    const updateProps = vi.fn();
    const first = node(database("a"));
    expect(updateAtomNodeView({ oldNode: first, newNode: first, updateProps })).toBe(true);
    expect(updateProps).not.toHaveBeenCalled();
    expect(updateAtomNodeView({ oldNode: first, newNode: node(database("a")), updateProps })).toBe(
      true,
    );
    expect(updateProps).toHaveBeenCalledOnce();
    expect(
      updateAtomNodeView({ oldNode: node(divider), newNode: node(divider), updateProps }),
    ).toBe(true);
  });
});
