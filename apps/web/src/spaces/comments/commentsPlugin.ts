import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  anchorSpaceComment,
  captureSpaceCommentRange,
  groupSpaceCommentThreads,
} from "@t2code/client-runtime/spaces";
import type {
  SpaceBlockId,
  SpaceCommentAnchor,
  SpaceCommentThread,
  SpaceCommentThreadId,
} from "@t2code/contracts/spaces";

export interface SpaceCommentSource {
  /** Open threads of this editor's page (the source page inside a synced copy). */
  threads(): readonly SpaceCommentThread[];
  activeThreadId(): SpaceCommentThreadId | null;
  open(target: {
    blockId: SpaceBlockId;
    threadId?: SpaceCommentThreadId;
    element: HTMLElement;
  }): void;
  compose(target: {
    blockId: SpaceBlockId;
    anchor: SpaceCommentAnchor;
    element: HTMLElement;
  }): void;
  /** Capability and permission to write comments. */
  enabled(): boolean;
}

interface CommentsState {
  readonly decorations: DecorationSet;
}

const key = new PluginKey<CommentsState>("spaceComments");
const blockIdOf = (node: ProseMirrorNode) =>
  (node.attrs.block as { id: SpaceBlockId } | null | undefined)?.id ?? null;

export function spaceCommentsRefresh(tr: Transaction): Transaction {
  return tr.setMeta(key, true);
}

function bubble(blockId: SpaceBlockId, count: number, active: boolean) {
  const button = document.createElement("button");
  button.type = "button";
  button.contentEditable = "false";
  button.className = active
    ? "space-comment-bubble space-comment-bubble-active"
    : "space-comment-bubble";
  button.textContent = String(count);
  button.setAttribute("aria-label", count === 1 ? "1 comment" : `${count} comments`);
  button.setAttribute("data-space-comment-block", blockId);
  return button;
}

function build(doc: ProseMirrorNode, source: SpaceCommentSource): CommentsState {
  const { byBlock } = groupSpaceCommentThreads(source.threads());
  if (byBlock.size === 0) return { decorations: DecorationSet.empty };
  const active = source.activeThreadId();
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    const id = blockIdOf(node);
    const threads = id === null ? undefined : byBlock.get(id);
    if (id === null || threads === undefined) return true;
    const isActive = threads.some((thread) => thread.id === active);
    decorations.push(
      Decoration.widget(pos + 1, () => bubble(id, threads.length, isActive), {
        side: -1,
        key: `${id}:${threads.length}:${isActive}`,
      }),
    );
    // A list item keeps its text in its first child; every other text block holds it directly.
    let body: { node: ProseMirrorNode; start: number } | null = null;
    if (node.isTextblock) body = { node, start: pos + 1 };
    else if (node.firstChild?.type.name === "spaceBody")
      body = { node: node.firstChild, start: pos + 2 };
    if (body === null) return true;
    const text = body.node.textContent;
    for (const thread of threads) {
      if (thread.anchor.kind !== "range") continue;
      const placement = anchorSpaceComment(text, thread.anchor);
      if (placement.kind !== "range") continue;
      decorations.push(
        Decoration.inline(
          body.start + placement.start,
          body.start + placement.end,
          {
            class:
              thread.id === active
                ? "space-comment-range space-comment-range-active"
                : "space-comment-range",
            "data-space-comment-thread": thread.id,
          },
          { comment: thread.id },
        ),
      );
    }
    return true;
  });
  return { decorations: DecorationSet.create(doc, decorations) };
}

/** The block under the caret, skipping tab panes, which are never comment targets. */
function blockAtSelection(state: EditorState) {
  const { $head } = state.selection;
  for (let depth = $head.depth; depth > 0; depth--) {
    const node = $head.node(depth);
    const id = blockIdOf(node);
    if (id !== null && node.type.name !== "tabPane") return id;
  }
  return null;
}

export function spaceCommentTarget(
  state: EditorState,
): { blockId: SpaceBlockId; anchor: SpaceCommentAnchor } | null {
  const { $from, $to, empty } = state.selection;
  const blockId = blockAtSelection(state);
  if (blockId === null) return null;
  if (!empty && $from.sameParent($to) && $from.parent.isTextblock) {
    const anchor = captureSpaceCommentRange(
      $from.parent.textContent,
      $from.parentOffset,
      $to.parentOffset,
    );
    if (anchor !== null) return { blockId, anchor };
  }
  return { blockId, anchor: { kind: "block" } };
}

/** Whether a range comment's text can no longer be found in its block. */
export function spaceCommentRangeGone(state: EditorState, thread: SpaceCommentThread): boolean {
  if (thread.anchor.kind !== "range" || thread.resolvedBlockId === undefined) return false;
  let gone = false;
  state.doc.descendants((node) => {
    if (blockIdOf(node) !== thread.resolvedBlockId) return true;
    const body = node.isTextblock ? node : node.firstChild;
    gone = body !== null && anchorSpaceComment(body.textContent, thread.anchor).kind === "block";
    return false;
  });
  return gone;
}

export const spaceCommentBlockElement = (root: HTMLElement, id: SpaceBlockId) =>
  root.querySelector<HTMLElement>(`[data-space-block="${CSS.escape(id)}"]`);

/**
 * Comment highlights and block bubbles. They live in this plugin's closure and decorations, never
 * in the document, so a comment never touches page content or its revision.
 */
export function spaceCommentsPlugin(source: SpaceCommentSource) {
  return new Plugin<CommentsState>({
    key,
    state: {
      init: (_, state) => build(state.doc, source),
      apply: (tr, value, _old, state) => {
        if (tr.getMeta(key)) return build(state.doc, source);
        return tr.docChanged ? { decorations: value.decorations.map(tr.mapping, tr.doc) } : value;
      },
    },
    props: {
      decorations: (state) => key.getState(state)?.decorations,
      handleDOMEvents: {
        mousedown: (_view, event) => {
          if (
            !(event.target instanceof Element) ||
            !event.target.closest("[data-space-comment-block]")
          )
            return false;
          event.preventDefault();
          return true;
        },
        click: (_view, event) => {
          if (!(event.target instanceof Element)) return false;
          const bubbleElement = event.target.closest<HTMLElement>("[data-space-comment-block]");
          const blockId = bubbleElement?.getAttribute("data-space-comment-block");
          if (bubbleElement && blockId) {
            event.preventDefault();
            source.open({ blockId: blockId as SpaceBlockId, element: bubbleElement });
            return true;
          }
          const range = event.target.closest<HTMLElement>("[data-space-comment-thread]");
          const threadId = range?.getAttribute("data-space-comment-thread");
          const thread = source.threads().find((candidate) => candidate.id === threadId);
          if (range && thread?.resolvedBlockId) {
            event.preventDefault();
            source.open({ blockId: thread.resolvedBlockId, threadId: thread.id, element: range });
            return true;
          }
          return false;
        },
      },
      handleKeyDown: (view, event) => {
        if (
          !(event.altKey && (event.metaKey || event.ctrlKey) && event.code === "KeyM") ||
          view.composing ||
          !source.enabled()
        )
          return false;
        const target = spaceCommentTarget(view.state);
        const element = target && spaceCommentBlockElement(view.dom, target.blockId);
        if (!target || !element) return false;
        event.preventDefault();
        source.compose({ ...target, element });
        return true;
      },
    },
  });
}
