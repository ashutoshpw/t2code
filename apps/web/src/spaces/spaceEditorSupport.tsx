import { toastManager } from "../components/ui/toast";
import { type Editor } from "@tiptap/core";
import { createContext } from "react";
import {
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListIcon,
  ListOrderedIcon,
  ListCollapseIcon,
  ListTodoIcon,
  MessageSquareIcon,
  PilcrowIcon,
  QuoteIcon,
  type LucideIcon,
} from "lucide-react";
import { NodeSelection, type Command, type EditorState } from "@tiptap/pm/state";
import { type SpaceBlock, type SpaceBlockId } from "@t2code/contracts/spaces";
import { isKnownSpaceBlock } from "@t2code/client-runtime/spaces";
import { SpaceEditorAdapter } from "./adapter";
import { spaceDocumentBlocks } from "./document";
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

type ConvertType = Parameters<SpaceEditorAdapter["convert"]>[1];

export const TURN_INTO: readonly {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly type: ConvertType;
  readonly level?: 1 | 2 | 3;
}[] = [
  { key: "paragraph", label: "Paragraph", icon: PilcrowIcon, type: "paragraph" },
  { key: "heading-1", label: "Heading 1", icon: Heading1Icon, type: "heading", level: 1 },
  { key: "heading-2", label: "Heading 2", icon: Heading2Icon, type: "heading", level: 2 },
  { key: "heading-3", label: "Heading 3", icon: Heading3Icon, type: "heading", level: 3 },
  { key: "quote", label: "Quote", icon: QuoteIcon, type: "quote" },
  { key: "callout", label: "Callout", icon: MessageSquareIcon, type: "callout" },
  { key: "bulleted_item", label: "Bullet list", icon: ListIcon, type: "bulleted_item" },
  { key: "numbered_item", label: "Numbered list", icon: ListOrderedIcon, type: "numbered_item" },
  { key: "todo_item", label: "To-do", icon: ListTodoIcon, type: "todo_item" },
  { key: "toggle", label: "Toggle list", icon: ListCollapseIcon, type: "toggle" },
];

type TurnIntoEntry = (typeof TURN_INTO)[number];

export function canTurnInto(
  adapter: SpaceEditorAdapter,
  state: EditorState,
  id: SpaceBlockId,
  entry: TurnIntoEntry,
): boolean {
  return (
    adapter.convert(id, entry.type)(state) ||
    (!!entry.level && adapter.setHeadingLevel(id, entry.level)(state))
  );
}

export function runTurnInto(
  editor: Editor,
  editable: boolean,
  adapter: SpaceEditorAdapter,
  id: SpaceBlockId,
  entry: TurnIntoEntry,
) {
  const typeOf = () => spaceDocumentBlocks(editor.state.doc).find((block) => block.id === id);
  if (typeOf()?.type !== entry.type) runCommand(editor, editable, adapter.convert(id, entry.type));
  const block = typeOf();
  if (entry.level && block && isKnownSpaceBlock(block) && block.type === "heading") {
    if (block.content.level !== entry.level)
      runCommand(editor, editable, adapter.setHeadingLevel(id, entry.level));
  }
}

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

/**
 * Whether an event came from a nested editor that this handler's own editor does not own. Events
 * of a synced copy's editor bubble through React into the host's handlers.
 */
export function fromNestedEditor(event: {
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
}) {
  const { target, currentTarget } = event;
  if (!(target instanceof Element) || !(currentTarget instanceof Element)) return false;
  return (
    target.closest("[data-space-nested-editor]") !==
    currentTarget.closest("[data-space-nested-editor]")
  );
}
