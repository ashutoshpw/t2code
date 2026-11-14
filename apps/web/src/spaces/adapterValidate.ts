import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { spaceAllowedInSynced } from "@t2code/contracts/spaces";

import {
  sameSpaceValue,
  spaceBlockNode,
  spaceDocumentBlocks,
  spaceWindowDocument,
  type SpaceEditorWindow,
} from "./document";
import { entries, type SpaceEditorOptions } from "./adapterModel";

/** Throws unless `doc` is a document this editor may hold; returns its canonical blocks. */
export function validateSpaceEditorDocument(
  doc: ProseMirrorNode,
  window: SpaceEditorWindow,
  options: SpaceEditorOptions,
) {
  doc.check();
  const blocks = spaceDocumentBlocks(doc);
  spaceWindowDocument({ ...window, blocks }, options.maxBlocks, options.maxDepth);
  for (const entry of entries(doc)) {
    if (
      entry.node.type.name !== "spaceAtom" &&
      spaceBlockNode(blocks.find((block) => block.id === entry.block.id)!).type.name !==
        entry.node.type.name
    )
      throw new Error("Unsupported editor content");
  }
  if (blocks.some((block) => JSON.stringify(block.content).length > options.maxTextLength))
    throw new Error("Editor content limit exceeded");
  const visit = (node: ProseMirrorNode, inside: boolean) => {
    if (inside && !spaceAllowedInSynced(node.attrs.block?.type ?? ""))
      throw new Error("Synced block nesting");
    node.forEach((child) => visit(child, inside || node.type.name === "syncedBlock"));
  };
  doc.forEach((child) => visit(child, false));
  if (options.rootBlockId !== undefined) {
    const root = window.blocks.find((block) => block.id === options.rootBlockId);
    if (
      doc.childCount !== 1 ||
      doc.firstChild!.attrs.block?.id !== options.rootBlockId ||
      !sameSpaceValue(blocks[0], root)
    )
      throw new Error("A synced editor holds exactly its original");
  }
  return blocks;
}
