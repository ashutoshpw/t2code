import { NodeSelection, TextSelection, type Command } from "@tiptap/pm/state";
import { spaceAllowedInSynced, spaceNestingAllowed } from "@t2code/contracts/spaces";
import type { SpaceBlock, SpaceBlockId } from "@t2code/contracts/spaces";
import { spaceBlockHoldsChildren } from "@t2code/client-runtime/spaces";

import type { SpaceEditorAdapter } from "../adapter";
import { entries } from "../adapterModel";
import { spaceBlockNode } from "../document";

const paragraph = (id: SpaceBlockId, parentId: SpaceBlockId | null, order: string): SpaceBlock => ({
  id,
  parentId,
  order,
  type: "paragraph",
  version: 1,
  content: { runs: [] },
});

type Entry = ReturnType<typeof entries>[number];

function ancestorTypes(all: readonly Entry[], parentId: SpaceBlockId | null) {
  const byId = new Map(all.map((item) => [item.block.id, item.block]));
  const types: string[] = [];
  for (let at = parentId; at !== null;) {
    const block = byId.get(at);
    if (!block) break;
    types.push(block.type);
    at = block.parentId;
  }
  return types;
}

/**
 * Inserts a block of `kind` after `afterId` inside its parent, replacing an empty paragraph there.
 * Returns null where the nesting rules refuse it, so callers can fall back.
 */
function insertAfter(
  adapter: SpaceEditorAdapter,
  afterId: SpaceBlockId | null,
  kind: "synced_block" | "synced_ref",
  sourceBlockId?: SpaceBlockId,
): Command {
  return adapter.structural((state, tools) => {
    const all = entries(state.doc);
    const top = afterId === null ? undefined : all.find((item) => item.block.id === afterId);
    if (afterId !== null && !top) return null;
    const parentId = top?.block.parentId ?? null;
    if (!tools.complete(parentId) || !spaceNestingAllowed(kind, ancestorTypes(all, parentId)))
      return null;
    const siblings = all.filter((item) => item.block.parentId === parentId);
    const index = top ? siblings.indexOf(top) : siblings.length - 1;
    const replace =
      top?.block.type === "paragraph" && top.node.textContent === "" && top.node.childCount === 0;
    const following = siblings[index + 1]?.block;
    const placed: SpaceBlock = {
      id: tools.id(),
      parentId,
      order: tools.rank(parentId, siblings[replace ? index - 1 : index]?.block, following),
      type: kind,
      version: 1,
      content: kind === "synced_ref" ? { sourceBlockId: sourceBlockId! } : {},
    };
    const nodes = [
      spaceBlockNode(
        placed,
        kind === "synced_block"
          ? [
              spaceBlockNode(
                paragraph(tools.id(), placed.id, tools.rank(placed.id, undefined, undefined)),
                [],
                false,
                state.schema,
              ),
            ]
          : [],
        false,
        state.schema,
      ),
    ];
    if (!following)
      nodes.push(
        spaceBlockNode(
          paragraph(tools.id(), parentId, tools.rank(parentId, placed, undefined)),
          [],
          false,
          state.schema,
        ),
      );
    const from = !top ? state.doc.content.size : replace ? top.pos : top.pos + top.node.nodeSize;
    const tr = state.tr.replaceWith(
      from,
      top && replace ? top.pos + top.node.nodeSize : from,
      nodes,
    );
    return kind === "synced_ref"
      ? tr.setSelection(NodeSelection.create(tr.doc, from))
      : tr.setSelection(TextSelection.near(tr.doc.resolve(from + 2)));
  });
}

/** A new original with one empty paragraph, so there is somewhere to write. */
export const insertSynced = (adapter: SpaceEditorAdapter, afterId: SpaceBlockId | null): Command =>
  insertAfter(adapter, afterId, "synced_block");

/** A copy of the original `sourceBlockId`. */
export const insertSyncedRef = (
  adapter: SpaceEditorAdapter,
  afterId: SpaceBlockId | null,
  sourceBlockId: SpaceBlockId,
): Command => insertAfter(adapter, afterId, "synced_ref", sourceBlockId);

/** Makes `blockId` and its descendants the content of a new original at the same place. */
export function wrapInSynced(
  adapter: SpaceEditorAdapter,
  blockId: SpaceBlockId,
  onCreated?: (id: SpaceBlockId) => void,
): Command {
  return adapter.structural((state, tools) => {
    const all = entries(state.doc);
    const entry = all.find((item) => item.block.id === blockId);
    if (!entry || entry.node.type.name === "spaceMedia") return null;
    const { parentId } = entry.block;
    if (
      !tools.complete(parentId) ||
      !spaceNestingAllowed("synced_block", ancestorTypes(all, parentId))
    )
      return null;
    const subtree = entries(state.schema.nodes.doc!.create(null, [entry.node]));
    if (
      subtree.some(
        (item) =>
          !spaceAllowedInSynced(item.block.type) ||
          item.node.type.name === "spaceMedia" ||
          (spaceBlockHoldsChildren(item.block) && !tools.complete(item.block.id)),
      )
    )
      return null;
    const original: SpaceBlock = {
      id: tools.id(),
      parentId,
      order: entry.block.order,
      type: "synced_block",
      version: 1,
      content: {},
    };
    const moved = entry.node.type.create(
      {
        ...entry.node.attrs,
        block: {
          ...entry.block,
          parentId: original.id,
          order: tools.rank(original.id, undefined, undefined),
        },
      },
      entry.node.content,
    );
    onCreated?.(original.id);
    return state.tr.replaceWith(
      entry.pos,
      entry.pos + entry.node.nodeSize,
      spaceBlockNode(original, [moved], false, state.schema),
    );
  });
}

/** Gives an empty original one empty paragraph and puts the caret in it. */
export function fillSynced(adapter: SpaceEditorAdapter, blockId: SpaceBlockId): Command {
  return adapter.structural((state, tools) => {
    const entry = entries(state.doc).find(
      (item) => item.block.id === blockId && item.node.type.name === "syncedBlock",
    );
    if (!entry || entry.node.childCount > 0 || !tools.complete(blockId)) return null;
    const at = entry.pos + 1;
    const body = paragraph(tools.id(), blockId, tools.rank(blockId, undefined, undefined));
    const tr = state.tr.insert(at, spaceBlockNode(body, [], false, state.schema));
    return tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
  });
}
