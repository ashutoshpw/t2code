import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceBlockId,
  SpaceCommentAnchor,
  SpaceCommentThread,
  SpaceCommentThreadId,
  SpacePageId,
} from "@t2code/contracts/spaces";
import type { EditorView } from "@tiptap/pm/view";

import {
  spaceCommentRangeGone,
  spaceCommentsRefresh,
  type SpaceCommentSource,
} from "./commentsPlugin";
import { openSpaceCommentsPanel } from "./spaceCommentsPanelState";

interface SpaceCommentPopover {
  readonly kind: "thread" | "compose";
  readonly blockId: SpaceBlockId;
  readonly threadId?: SpaceCommentThreadId;
  readonly anchor?: SpaceCommentAnchor;
  readonly element: HTMLElement;
}

interface SpaceCommentsSnapshot {
  readonly threads: readonly SpaceCommentThread[];
  readonly popover: SpaceCommentPopover | null;
}

const WIDE_PAGE_PX = 960;

/**
 * The per-viewer comment state of one editor. The editor plugin reads it through
 * `SpaceCommentSource`; React reads `getSnapshot`. Nothing here is saved with the page.
 */
export class SpaceCommentsController implements SpaceCommentSource {
  #snapshot: SpaceCommentsSnapshot = { threads: [], popover: null };
  #enabled = false;
  #view: EditorView | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(
    readonly environmentId: EnvironmentId,
    readonly pageId: SpacePageId,
  ) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  getSnapshot = () => this.#snapshot;

  threads() {
    return this.#snapshot.threads;
  }

  activeThreadId() {
    return this.#snapshot.popover?.threadId ?? null;
  }

  enabled() {
    return this.#enabled;
  }

  setEnabled(enabled: boolean) {
    this.#enabled = enabled;
  }

  attach(view: EditorView) {
    this.#view = view;
    if (this.#snapshot.threads.length > 0) this.#refresh();
    return () => {
      if (this.#view === view) this.#view = null;
    };
  }

  setThreads(threads: readonly SpaceCommentThread[]) {
    this.#set({ ...this.#snapshot, threads });
  }

  open(target: { blockId: SpaceBlockId; threadId?: SpaceCommentThreadId; element: HTMLElement }) {
    const wide =
      (target.element.closest("[data-space-comments-wide]")?.clientWidth ?? 0) >= WIDE_PAGE_PX;
    if (!wide) {
      const threadId = target.threadId ?? this.#firstThread(target.blockId);
      openSpaceCommentsPanel({
        environmentId: this.environmentId,
        pageId: this.pageId,
        ...(threadId === undefined ? {} : { commentThreadId: threadId }),
      });
      return;
    }
    this.#set({ ...this.#snapshot, popover: { kind: "thread", ...target } });
  }

  compose(target: { blockId: SpaceBlockId; anchor: SpaceCommentAnchor; element: HTMLElement }) {
    this.#set({ ...this.#snapshot, popover: { kind: "compose", ...target } });
  }

  close() {
    if (this.#snapshot.popover !== null) this.#set({ ...this.#snapshot, popover: null });
  }

  /** The popover's anchor, found again when a refresh replaced the element it was opened on. */
  anchorOf(popover: SpaceCommentPopover): HTMLElement {
    if (popover.element.isConnected || this.#view === null) return popover.element;
    const id = CSS.escape(popover.blockId);
    return (
      this.#view.dom.querySelector<HTMLElement>(`[data-space-comment-block="${id}"]`) ??
      this.#view.dom.querySelector<HTMLElement>(`[data-space-block="${id}"]`) ??
      popover.element
    );
  }

  rangeGone(thread: SpaceCommentThread) {
    return this.#view !== null && spaceCommentRangeGone(this.#view.state, thread);
  }

  #firstThread(blockId: SpaceBlockId) {
    return this.#snapshot.threads.find((thread) => thread.resolvedBlockId === blockId)?.id;
  }

  #set(next: SpaceCommentsSnapshot) {
    this.#snapshot = next;
    this.#refresh();
    for (const listener of this.#listeners) listener();
  }

  // While composing text, replacing decorations would interrupt the IME; the next change retries.
  #refresh() {
    const view = this.#view;
    if (view === null || view.isDestroyed || view.composing) return;
    view.dispatch(spaceCommentsRefresh(view.state.tr));
  }
}
