import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import {
  canEditSpaceBlock,
  isKnownSpaceBlock,
  isSpaceListItem,
  spaceBlockRuns,
} from "@t2code/client-runtime/spaces";
import type {
  SpaceBlock,
  SpaceBlockId,
  SpaceBlockWindow,
  SpaceMark,
  SpaceRichText,
} from "@t2code/contracts/spaces";

import { spaceSchema } from "./schema";

export interface SpaceEditorWindow extends SpaceBlockWindow {
  // Membership alone cannot prove adjacency or that a container has no unloaded children.
  readonly completeParents: readonly (SpaceBlockId | null)[];
}

export function sameSpaceValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, i) => sameSpaceValue(value, b[i]))
    );
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = Object.entries(a);
    const right = Object.entries(b);
    return (
      left.length === right.length &&
      left.every(
        ([key, value]) => Object.hasOwn(b, key) && sameSpaceValue(value, Reflect.get(b, key)),
      )
    );
  }
  return false;
}

export function canEditSpaceEditorBlock(block: SpaceBlock) {
  const runs = spaceBlockRuns(block);
  return (
    canEditSpaceBlock(block) &&
    (!runs ||
      runs.every((run) => new Set(run.marks.map((mark) => mark.type)).size === run.marks.length))
  );
}

function richTextNodes(runs: SpaceRichText, schema: Schema = spaceSchema) {
  return runs.flatMap((run) =>
    run.text
      ? [
          schema.text(
            run.text,
            run.marks.map((value) => schema.marks[`space_${value.type}`]!.create({ value })),
          ),
        ]
      : [],
  );
}

export function spaceBlockNode(
  block: SpaceBlock,
  children: readonly ProseMirrorNode[] = [],
  readOnly = false,
  schema: Schema = spaceSchema,
): ProseMirrorNode {
  const attrs = { block };
  const runs = spaceBlockRuns(block);
  if (!readOnly && canEditSpaceEditorBlock(block) && runs) {
    const inline = richTextNodes(runs, schema);
    return schema.nodes[block.type]!.create(
      attrs,
      isSpaceListItem(block) ? [schema.nodes.spaceBody!.create(null, inline), ...children] : inline,
    );
  }
  if (
    !readOnly &&
    canEditSpaceEditorBlock(block) &&
    isKnownSpaceBlock(block) &&
    block.type === "code"
  ) {
    return schema.nodes.code!.create(
      attrs,
      block.content.text ? schema.text(block.content.text) : null,
    );
  }
  return schema.nodes.spaceAtom!.create(attrs);
}

export function spaceWindowDocument(
  window: SpaceEditorWindow,
  maxBlocks: number,
  maxDepth: number,
  schema: Schema = spaceSchema,
): ProseMirrorNode {
  if (window.blocks.length > maxBlocks) throw new Error("Loaded block window exceeds editor limit");
  if (!Number.isSafeInteger(window.revision) || window.revision < 0)
    throw new Error("Invalid window revision");
  const byId = new Map(window.blocks.map((block) => [block.id, block]));
  if (byId.size !== window.blocks.length) throw new Error("Duplicate block ID");
  const readOnlyIds = new Set<SpaceBlockId>();
  for (const block of window.blocks) {
    const seen = new Set([block.id]);
    let parent = block.parentId;
    while (parent !== null && byId.has(parent)) {
      if (seen.has(parent)) throw new Error("Block parent cycle");
      seen.add(parent);
      if (seen.size > maxDepth) throw new Error("Editor nesting limit exceeded");
      const ancestor = byId.get(parent)!;
      if (!isSpaceListItem(ancestor) || !canEditSpaceEditorBlock(ancestor))
        readOnlyIds.add(block.id);
      if (isKnownSpaceBlock(ancestor) && !isSpaceListItem(ancestor))
        throw new Error("Only list items contain blocks");
      parent = ancestor.parentId;
    }
  }
  const nests = (block: SpaceBlock) =>
    block.parentId !== null && byId.has(block.parentId) && !readOnlyIds.has(block.id);
  const build = (block: SpaceBlock): ProseMirrorNode =>
    spaceBlockNode(
      block,
      window.blocks.filter((child) => child.parentId === block.id && nests(child)).map(build),
      readOnlyIds.has(block.id),
      schema,
    );
  return schema.nodes.doc!.create(null, window.blocks.filter((block) => !nests(block)).map(build));
}

function nodeRuns(node: ProseMirrorNode): SpaceRichText {
  const runs: { text: string; marks: readonly SpaceMark[] }[] = [];
  node.forEach((child) => {
    if (!child.isText) throw new Error("Unsupported rich text node");
    runs.push({
      text: child.text!,
      marks: child.marks.map((mark) => mark.attrs.value as SpaceMark),
    });
  });
  return runs;
}

export function spaceDocumentBlocks(doc: ProseMirrorNode): readonly SpaceBlock[] {
  const result: SpaceBlock[] = [];
  const walk = (node: ProseMirrorNode, parentId: SpaceBlockId | null) => {
    const original = node.attrs.block as SpaceBlock;
    if (!original?.id) throw new Error("Missing canonical block identity");
    let block = { ...original, parentId };
    if (node.type.name !== "spaceAtom") {
      if (node.type.name === "code") {
        const content = {
          text: node.textContent,
          language:
            isKnownSpaceBlock(original) && original.type === "code"
              ? original.content.language
              : "",
        };
        block = {
          ...block,
          content: sameSpaceValue(content, original.content) ? original.content : content,
        };
      } else {
        const body = isSpaceListItem(original) ? node.firstChild! : node;
        const originalNode = spaceBlockNode(original, [], false, node.type.schema);
        const originalBody = isSpaceListItem(original) ? originalNode.firstChild! : originalNode;
        if (!body.content.eq(originalBody.content)) {
          if (!isKnownSpaceBlock(original) || !("runs" in original.content))
            throw new Error("Read-only content");
          block = { ...block, content: { ...original.content, runs: nodeRuns(body) } };
        }
      }
    }
    result.push(block);
    if (isSpaceListItem(original) && node.type.name !== "spaceAtom")
      node.forEach((child, _offset, i) => {
        if (i > 0) walk(child, original.id);
      });
  };
  doc.forEach((node) => walk(node, (node.attrs.block as SpaceBlock).parentId));
  return result;
}
