import { toastManager } from "../components/ui/toast";
import { type Editor } from "@tiptap/core";
import { createContext } from "react";
import {
  Heading1Icon,
  ListIcon,
  ListOrderedIcon,
  ListCollapseIcon,
  ListTodoIcon,
  MessageSquareIcon,
  PilcrowIcon,
  QuoteIcon,
} from "lucide-react";
import { NodeSelection, type Command, type EditorState } from "@tiptap/pm/state";
import { type SpaceBlock, type SpaceBlockId } from "@t2code/contracts/spaces";
import { SpaceEditorAdapter } from "./adapter";
import type { SpaceEditorBridge } from "./editorBridge";

export function slashMatch(state: EditorState) {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.name === "code") return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(before);
  return match ? { from: $from.pos - match[1]!.length - 1, query: match[1]! } : null;
}

export type SlashItem = {
  readonly label: string;
  readonly icon: typeof PilcrowIcon;
  readonly keywords: string;
  readonly apply: (id: SpaceBlockId | null) => void;
};

export const turnInto = {
  paragraph: ["Paragraph", PilcrowIcon],
  heading: ["Heading", Heading1Icon],
  quote: ["Quote", QuoteIcon],
  callout: ["Callout", MessageSquareIcon],
  bulleted_item: ["Bullet list", ListIcon],
  numbered_item: ["Numbered list", ListOrderedIcon],
  todo_item: ["To-do", ListTodoIcon],
  toggle: ["Toggle list", ListCollapseIcon],
} as const;

export const SpaceEditorWrapperContext = createContext<HTMLElement | null>(null);

export function selectedBlock(state: EditorState): SpaceBlock | null {
  let block =
    state.selection instanceof NodeSelection
      ? (state.selection.node.attrs.block as SpaceBlock | undefined)
      : undefined;
  for (let depth = state.selection.$from.depth; depth > 0; depth--) {
    const candidate = state.selection.$from.node(depth).attrs.block as SpaceBlock | undefined;
    if (candidate?.id) {
      block = candidate;
      break;
    }
  }
  return block?.id ? block : null;
}

export function editorCapabilities(
  bridge: SpaceEditorBridge | undefined,
  editable: boolean,
  hasMoveHandler: boolean,
) {
  const writable = editable && (bridge?.canEdit() ?? true);
  const structure = writable && (bridge?.canStructure() ?? true);
  const complete = !bridge || bridge.controller.editorWindow().completeParents.includes(null);
  const canMove =
    !!bridge &&
    hasMoveHandler &&
    structure &&
    !bridge.controller.session.structureAvailability() &&
    complete;
  return { writable, structure, complete, canMove };
}

export function runCommand(editor: Editor, editable: boolean, command: Command) {
  if (editor.isDestroyed || !editable) return;
  try {
    if (!command(editor.state, editor.view.dispatch))
      toastManager.add({ type: "error", title: "That action isn't available here" });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Couldn't apply that change",
      description: error instanceof Error ? error.message : undefined,
    });
  }
  editor.view.focus();
}

export function placeAt(editor: Editor, wrapper: HTMLElement | null, pos: number, width: number) {
  const box = wrapper?.getBoundingClientRect();
  if (!box) return null;
  try {
    const at = editor.view.coordsAtPos(pos);
    return {
      left: Math.max(0, Math.min(at.left - box.left, box.width - width)),
      top: at.top - box.top,
      bottom: at.bottom - box.top,
    };
  } catch {
    return null;
  }
}

export type SpaceEditorParts = {
  readonly editor: Editor;
  readonly adapter: SpaceEditorAdapter;
  readonly bridge: SpaceEditorBridge | undefined;
  readonly editable: boolean;
};
