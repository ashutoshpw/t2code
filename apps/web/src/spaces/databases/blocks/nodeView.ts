import { ReactNodeViewRenderer } from "@tiptap/react";
import type { NodeViewRenderer } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { isSpaceDatabaseBlock } from "@t2code/client-runtime/spaces";

import { SpaceAtomView } from "../../SpaceAtomView";
import { DatabaseNodeView } from "./DatabaseNodeView";

/** A database view is bound to its block: another id means another view. */
const nodeViewKey = (node: ProseMirrorNode) => {
  const block: unknown = node.attrs.block;
  return isSpaceDatabaseBlock(block) ? `database:${block.id}` : "plain";
};

/**
 * Tiptap reuses a node view while the node type matches, so a database and a plain atom must
 * not share one: returning false from `update` makes ProseMirror rebuild the view.
 */
export const updateAtomNodeView = ({
  oldNode,
  newNode,
  updateProps,
}: {
  readonly oldNode: ProseMirrorNode;
  readonly newNode: ProseMirrorNode;
  readonly updateProps: () => void;
}) => {
  if (nodeViewKey(oldNode) !== nodeViewKey(newNode)) return false;
  if (oldNode !== newNode) updateProps();
  return true;
};

const plain = ReactNodeViewRenderer(SpaceAtomView, { update: updateAtomNodeView });
const database = ReactNodeViewRenderer(DatabaseNodeView, {
  update: updateAtomNodeView,
  stopEvent: () => true,
});

/** Divider, child page, media and unknown blocks keep tiptap's default event handling. */
export function spaceAtomNodeView(): NodeViewRenderer {
  return (props) => (nodeViewKey(props.node) === "plain" ? plain(props) : database(props));
}
