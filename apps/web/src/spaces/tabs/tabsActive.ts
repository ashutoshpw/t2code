import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { TextSelection } from "@tiptap/pm/state";

interface TabsState {
  readonly chosen: ReadonlyMap<string, string>;
  readonly current: ReadonlyMap<string, string>;
  readonly decorations: DecorationSet;
}
interface SwitchMeta {
  readonly tabs: string;
  readonly pane: string;
}

const key = new PluginKey<TabsState>("spaceTabs");
const blockId = (node: ProseMirrorNode) => (node.attrs.block as { id: string }).id;

function build(doc: ProseMirrorNode, chosen: ReadonlyMap<string, string>): TabsState {
  const decorations: Decoration[] = [];
  const current = new Map<string, string>();
  const kept = new Map<string, string>();
  doc.descendants((node, pos) => {
    if (node.type.name !== "tabs") return;
    const panes: { id: string; pos: number; size: number }[] = [];
    node.forEach((pane, offset) =>
      panes.push({ id: blockId(pane), pos: pos + 1 + offset, size: pane.nodeSize }),
    );
    const id = blockId(node);
    const wanted = chosen.get(id);
    const active = panes.find((pane) => pane.id === wanted) ?? panes[0];
    if (!active) return;
    current.set(id, active.id);
    if (active.id === wanted) kept.set(id, wanted);
    for (const pane of panes)
      if (pane !== active)
        decorations.push(
          Decoration.node(pane.pos, pane.pos + pane.size, { "data-space-pane-hidden": "" }),
        );
  });
  return { chosen: kept, current, decorations: DecorationSet.create(doc, decorations) };
}

// Typing inside a pane only has tabs nodes as ancestors; a structural edit starts or ends one inside a range.
function touchesTabs(tr: Transaction) {
  let found = false;
  tr.mapping.maps.forEach((map, index) =>
    map.forEach((oldStart, oldEnd, newStart, newEnd) => {
      const check = (doc: ProseMirrorNode, from: number, to: number) => {
        if (found || from > to) return;
        doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === "tabs" || node.type.name === "tabPane")
            if (pos >= from || pos + node.nodeSize <= to) found = true;
          return !found;
        });
      };
      check(tr.docs[index]!, oldStart, oldEnd);
      check(tr.docs[index + 1] ?? tr.doc, newStart, newEnd);
    }),
  );
  return found;
}

function paneAt(doc: ProseMirrorNode, pos: number): SwitchMeta | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--)
    if ($pos.node(depth).type.name === "tabPane")
      return { tabs: blockId($pos.node(depth - 1)), pane: blockId($pos.node(depth)) };
  return null;
}

export function activeSpacePane(state: EditorState, tabsId: string): string | null {
  return key.getState(state)?.current.get(tabsId) ?? null;
}

export function spaceTabsMeta(tr: Transaction, tabsId: string, paneId: string): Transaction {
  return tr.setMeta(key, { tabs: tabsId, pane: paneId } satisfies SwitchMeta);
}

/** Switches the open pane for this viewer and moves a caret out of the pane being hidden. */
export function switchSpacePane(state: EditorState, tabsId: string, paneId: string): Transaction {
  const tr = spaceTabsMeta(state.tr, tabsId, paneId);
  const inside = paneAt(state.doc, state.selection.head);
  if (inside?.tabs !== tabsId || inside.pane === paneId) return tr;
  let target: number | null = null;
  state.doc.descendants((node, pos) => {
    if (target === null && node.type.name === "tabPane" && blockId(node) === paneId) target = pos;
    return target === null;
  });
  return target === null ? tr : tr.setSelection(TextSelection.near(state.doc.resolve(target + 1)));
}

// The open pane is per viewer and lives only in the editor view, never in the document.
// The choice is also kept in the plugin instance so a recreated editor state (save acknowledgement,
// live refresh) reopens the same pane.
export function spaceTabsPlugin() {
  let remembered: ReadonlyMap<string, string> = new Map();
  const remember = (value: TabsState) => {
    remembered = value.chosen;
    return value;
  };
  return new Plugin<TabsState>({
    key,
    state: {
      init: (_, state) => {
        const hit = paneAt(state.doc, state.selection.head);
        return remember(
          build(state.doc, hit ? new Map(remembered).set(hit.tabs, hit.pane) : remembered),
        );
      },
      apply(tr, value) {
        const meta = tr.getMeta(key) as SwitchMeta | undefined;
        let chosen = value.chosen;
        if (meta) chosen = new Map(chosen).set(meta.tabs, meta.pane);
        else if (tr.selectionSet) {
          const hit = paneAt(tr.doc, tr.selection.head);
          if (hit && value.current.get(hit.tabs) !== hit.pane)
            chosen = new Map(chosen).set(hit.tabs, hit.pane);
        }
        if (chosen !== value.chosen || (tr.docChanged && touchesTabs(tr)))
          return remember(build(tr.doc, chosen));
        return tr.docChanged
          ? { ...value, decorations: value.decorations.map(tr.mapping, tr.doc) }
          : value;
      },
    },
    props: { decorations: (state) => key.getState(state)?.decorations },
  });
}
