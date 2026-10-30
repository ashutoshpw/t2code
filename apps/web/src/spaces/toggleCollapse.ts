import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export interface CollapseState {
  readonly collapsed: ReadonlySet<string>;
  readonly decorations: DecorationSet;
}

const key = new PluginKey<CollapseState>("spaceToggleCollapse");

function build(doc: ProseMirrorNode, collapsed: ReadonlySet<string>) {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "toggle") return;
    const id = (node.attrs.block as { id: string }).id;
    const closed = collapsed.has(id);
    if (closed)
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { "data-space-collapsed": "" }));
    decorations.push(
      Decoration.widget(
        pos + 1,
        () => {
          const button = document.createElement("button");
          button.type = "button";
          button.contentEditable = "false";
          button.setAttribute("data-space-toggle-button", id);
          button.setAttribute("aria-expanded", String(!closed));
          button.setAttribute("aria-label", closed ? "Expand toggle" : "Collapse toggle");
          return button;
        },
        { side: -1, key: `${id}:${closed}`, ignoreSelection: true },
      ),
    );
  });
  return DecorationSet.create(doc, decorations);
}

export const spaceToggleCollapseKey = () => key;

export function isSpaceToggleCollapsed(state: EditorState, id: string) {
  return key.getState(state)?.collapsed.has(id) ?? false;
}

// Collapse state is per viewer and lives only in the editor view, never in the document.
export function spaceToggleCollapsePlugin() {
  return new Plugin<CollapseState>({
    key,
    state: {
      init: (_, state) => ({ collapsed: new Set(), decorations: build(state.doc, new Set()) }),
      apply(tr, value) {
        const toggled = tr.getMeta(key) as string | undefined;
        if (toggled === undefined && !tr.docChanged) return value;
        const collapsed = new Set(value.collapsed);
        if (toggled !== undefined) {
          if (!collapsed.delete(toggled)) collapsed.add(toggled);
        }
        return { collapsed, decorations: build(tr.doc, collapsed) };
      },
    },
    props: {
      decorations: (state) => key.getState(state)?.decorations,
      handleDOMEvents: {
        click: (view, event) => {
          const id =
            event.target instanceof HTMLElement
              ? event.target
                  .closest("[data-space-toggle-button]")
                  ?.getAttribute("data-space-toggle-button")
              : null;
          if (!id) return false;
          event.preventDefault();
          view.dispatch(view.state.tr.setMeta(key, id));
          return true;
        },
      },
    },
  });
}
