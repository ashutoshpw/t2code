import { type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Schema } from "effect";
import { isKnownSpaceBlock, type SpaceMutation } from "@t2code/client-runtime/spaces";
import {
  SpaceBlock,
  SpaceKnownMark,
  type SpaceBlockId,
  type SpacePageTarget,
} from "@t2code/contracts/spaces";
import { type SpaceEditorWindow } from "./document";

export interface SpaceEditorOptions {
  readonly target: SpacePageTarget;
  readonly window: SpaceEditorWindow;
  readonly maxBlocks: number;
  readonly maxDepth: number;
  readonly maxTextLength: number;
  readonly maxClipboardBytes: number;
  readonly allocateId: () => SpaceBlockId;
  readonly allocateOrder: (gap: {
    readonly parentId: SpaceBlockId | null;
    readonly before: string | null;
    readonly after: string | null;
  }) => string;
  readonly canEdit?: () => boolean;
  readonly canChangeStructure?: () => boolean;
  readonly canUndo?: () => boolean;
  readonly canEditMedia?: () => boolean;
  /** A synced editor: the document is exactly this block and its descendants. */
  readonly rootBlockId?: SpaceBlockId;
}
export interface SpaceEditorBatch {
  readonly baseRevision: number;
  readonly memberIds: readonly SpaceBlockId[];
  readonly mutations: readonly SpaceMutation[];
}
export interface MediaChange {
  readonly before: SpaceBlock | null;
  readonly after: SpaceBlock | null;
}
export interface Operation {
  readonly media?: MediaChange;
  readonly history?: boolean;
  /** Set by the database block commands, which may insert, delete and rewrite the view list. */
  readonly database?: boolean;
  readonly merged?: { readonly from: SpaceBlockId; readonly into: SpaceBlockId };
}
export interface AdapterState {
  readonly batch: SpaceEditorBatch;
  readonly joins: readonly NonNullable<Operation["merged"]>[];
}
export const decodeMentionMark = Schema.decodeOption(SpaceKnownMark, { onExcessProperty: "error" });
export const localHistoryDepth = 100;
export const clipboardType = "application/x-t2-spaces-blocks+json";
export const decodeClipboard = Schema.decodeUnknownSync(
  Schema.Struct({
    source: Schema.Struct({ environmentId: Schema.String, pageId: Schema.String }),
    blocks: Schema.Array(SpaceBlock),
  }),
);

export function entries(doc: ProseMirrorNode) {
  const result: { node: ProseMirrorNode; pos: number; block: SpaceBlock }[] = [];
  doc.descendants((node, pos, parent) => {
    const block = node.attrs.block as SpaceBlock | undefined;
    if (block)
      result.push({
        node,
        pos,
        block: {
          ...block,
          parentId: (parent?.attrs.block as SpaceBlock | undefined)?.id ?? block.parentId,
        },
      });
  });
  return result;
}

export function mediaIdentity(block: SpaceBlock | null) {
  return block && isKnownSpaceBlock(block)
    ? { ...block, content: { ...block.content, caption: [] } }
    : block;
}

export function captionBoundary(doc: ProseMirrorNode, position: number) {
  const point = doc.resolve(position);
  if (point.parent.type.name !== "spaceMedia") return true;
  const text = point.parent.textContent,
    offset = point.parentOffset;
  return !(
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[offset]!)
  );
}
