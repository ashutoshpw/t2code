import { TextSelection, type Command } from "@tiptap/pm/state";
import { SPACE_TAB_TITLE_MAX_LENGTH, spaceNestingAllowed } from "@t2code/contracts/spaces";
import type { SpaceBlock, SpaceBlockId } from "@t2code/contracts/spaces";
import { isSpaceTabPaneBlock } from "@t2code/client-runtime/spaces";

import type { SpaceEditorAdapter } from "../adapter";
import { entries } from "../adapterModel";
import { spaceBlockNode } from "../document";
import { spaceTabsMeta } from "./tabsActive";

const PANES_ON_INSERT = 3;

const paragraph = (id: SpaceBlockId, parentId: SpaceBlockId | null, order: string): SpaceBlock => ({
  id,
  parentId,
  order,
  type: "paragraph",
  version: 1,
  content: { runs: [] },
});

const pane = (
  id: SpaceBlockId,
  parentId: SpaceBlockId,
  order: string,
  title: string,
): SpaceBlock => ({ id, parentId, order, type: "tab_pane", version: 1, content: { title } });

/** Inserts a tabs block after `afterId` inside its parent, replacing an empty paragraph there. */
export function insertTabs(adapter: SpaceEditorAdapter, afterId: SpaceBlockId | null): Command {
  return adapter.structural((state, tools) => {
    const all = entries(state.doc);
    const top = afterId === null ? undefined : all.find((item) => item.block.id === afterId);
    if (afterId !== null && !top) return null;
    const parentId = top?.block.parentId ?? null;
    const parent = parentId === null ? undefined : all.find((item) => item.block.id === parentId);
    if (
      !tools.complete(parentId) ||
      !spaceNestingAllowed("tabs", parent ? [parent.block.type] : [])
    )
      return null;
    const siblings = all.filter((item) => item.block.parentId === parentId);
    const index = top ? siblings.indexOf(top) : siblings.length - 1;
    const replace =
      top?.block.type === "paragraph" && top.node.textContent === "" && top.node.childCount === 0;
    const following = siblings[index + 1]?.block;
    const tabs: SpaceBlock = {
      id: tools.id(),
      parentId,
      order: tools.rank(parentId, siblings[replace ? index - 1 : index]?.block, following),
      type: "tabs",
      version: 1,
      content: {},
    };
    let previous: SpaceBlock | undefined;
    const panes = Array.from({ length: PANES_ON_INSERT }, (_, i) => {
      const block = pane(
        tools.id(),
        tabs.id,
        tools.rank(tabs.id, previous, undefined),
        `Tab ${i + 1}`,
      );
      previous = block;
      return spaceBlockNode(
        block,
        [
          spaceBlockNode(
            paragraph(tools.id(), block.id, tools.rank(block.id, undefined, undefined)),
            [],
            false,
            state.schema,
          ),
        ],
        false,
        state.schema,
      );
    });
    const nodes = [spaceBlockNode(tabs, panes, false, state.schema)];
    if (!following)
      nodes.push(
        spaceBlockNode(
          paragraph(tools.id(), parentId, tools.rank(parentId, tabs, undefined)),
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
    const first = panes[0]!;
    spaceTabsMeta(tr, tabs.id, (first.attrs.block as SpaceBlock).id);
    return tr.setSelection(TextSelection.near(tr.doc.resolve(from + 3)));
  });
}

export function addPane(adapter: SpaceEditorAdapter, tabsId: SpaceBlockId): Command {
  return adapter.structural((state, tools) => {
    const all = entries(state.doc);
    const tabs = all.find((item) => item.block.id === tabsId && item.node.type.name === "tabs");
    if (!tabs || !tools.complete(tabsId)) return null;
    const panes = all.filter((item) => item.block.parentId === tabsId);
    const block = pane(
      tools.id(),
      tabsId,
      tools.rank(tabsId, panes.at(-1)?.block, undefined),
      `Tab ${panes.length + 1}`,
    );
    const body = paragraph(tools.id(), block.id, tools.rank(block.id, undefined, undefined));
    const at = tabs.pos + tabs.node.nodeSize - 1;
    const tr = state.tr.insert(
      at,
      spaceBlockNode(block, [spaceBlockNode(body, [], false, state.schema)], false, state.schema),
    );
    spaceTabsMeta(tr, tabsId, block.id);
    return tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2)));
  });
}

/** Gives an empty pane one empty paragraph and puts the caret in it. */
export function fillPane(adapter: SpaceEditorAdapter, paneId: SpaceBlockId): Command {
  return adapter.structural((state, tools) => {
    const entry = entries(state.doc).find(
      (item) => item.block.id === paneId && item.node.type.name === "tabPane",
    );
    if (!entry || entry.node.childCount > 0 || !tools.complete(paneId)) return null;
    const body = paragraph(tools.id(), paneId, tools.rank(paneId, undefined, undefined));
    const at = entry.pos + 1;
    const tr = state.tr.insert(at, spaceBlockNode(body, [], false, state.schema));
    return tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
  });
}

export function renamePane(
  adapter: SpaceEditorAdapter,
  paneId: SpaceBlockId,
  title: string,
): Command {
  const next = title.trim();
  return adapter.structural((state) => {
    const entry = entries(state.doc).find((item) => item.block.id === paneId);
    const current = entry?.node.attrs.block as SpaceBlock | undefined;
    if (
      !entry ||
      !current ||
      !isSpaceTabPaneBlock(current) ||
      next.length < 1 ||
      next.length > SPACE_TAB_TITLE_MAX_LENGTH ||
      next === current.content.title
    )
      return null;
    return state.tr.setNodeMarkup(entry.pos, undefined, {
      ...entry.node.attrs,
      block: { ...current, content: { ...current.content, title: next } },
    });
  });
}

/** Moves a pane before `beforePaneId` under the same tabs block; null moves it last. */
export function movePane(
  adapter: SpaceEditorAdapter,
  paneId: SpaceBlockId,
  beforePaneId: SpaceBlockId | null,
): Command {
  return (state, dispatch) => {
    const parentId = entries(state.doc).find((item) => item.block.id === paneId)?.block.parentId;
    return parentId ? adapter.move(paneId, parentId, beforePaneId)(state, dispatch) : false;
  };
}

/** Deletes a pane and its content; the last pane of a tabs block stays. */
export function removePane(adapter: SpaceEditorAdapter, paneId: SpaceBlockId): Command {
  return (state, dispatch) => {
    const all = entries(state.doc);
    const parentId = all.find((item) => item.block.id === paneId)?.block.parentId;
    if (!parentId || all.filter((item) => item.block.parentId === parentId).length < 2)
      return false;
    return adapter.remove(paneId)(state, dispatch);
  };
}
