import {
  EditorState,
  NodeSelection,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { SpaceBlockId } from "@t2code/contracts/spaces";
import { spaceJsonBytes, type SpaceCompensation } from "@t2code/client-runtime/spaces";
import { SpaceEditorAdapter } from "./adapter";
import { sameSpaceValue, spaceDocumentBlocks, spaceWindowDocument } from "./document";
import type { SpaceDocumentController } from "./documentController";

function allocateSpaceEditorOrder(gap: { before: string | null; after: string | null }): string {
  for (const rank of [gap.before, gap.after])
    if (rank !== null && !/^[0-9a-f]{32}$/.test(rank)) throw new Error("Unsupported block rank");
  const lower = gap.before === null ? -1n : BigInt(`0x${gap.before}`);
  const upper = gap.after === null ? 1n << 128n : BigInt(`0x${gap.after}`);
  if (upper - lower < 2n) throw new Error("No block rank gap; server rebalancing is required");
  return ((lower + upper) / 2n).toString(16).padStart(32, "0");
}

function preserveSelection(state: EditorState, doc: ProseMirrorNode) {
  const point = (position: number) => {
    const resolved = state.doc.resolve(position);
    for (let depth = resolved.depth; depth > 0; depth--) {
      const id = resolved.node(depth).attrs.block?.id as SpaceBlockId | undefined;
      if (!id) continue;
      let found: number | undefined;
      doc.descendants((node, pos) => {
        if (node.attrs.block?.id !== id) return;
        if (node.isTextblock) found = pos + 1 + Math.min(resolved.parentOffset, node.content.size);
        else if (node.firstChild?.isTextblock)
          found = pos + 2 + Math.min(resolved.parentOffset, node.firstChild.content.size);
      });
      return found;
    }
    return undefined;
  };
  if (state.selection instanceof NodeSelection) {
    const id = state.selection.node.attrs.block?.id as SpaceBlockId | undefined;
    let position: number | undefined;
    doc.descendants((node, pos) => {
      if (id && node.attrs.block?.id === id) position = pos;
    });
    if (position !== undefined) return NodeSelection.create(doc, position);
  }
  const anchor = point(state.selection.anchor),
    head = point(state.selection.head);
  return anchor !== undefined && head !== undefined
    ? TextSelection.create(doc, anchor, head)
    : Selection.near(doc.resolve(Math.min(state.selection.from, doc.content.size)));
}

export class SpaceEditorBridge {
  readonly adapter: SpaceEditorAdapter;
  readonly controller: SpaceDocumentController;
  #writable = false;
  #applying = false;
  #acknowledged: number | null;
  #notice: string | null = null;
  readonly #listeners = new Set<() => void>();
  constructor(controller: SpaceDocumentController, allocateId: () => SpaceBlockId) {
    this.controller = controller;
    this.#acknowledged = controller.session.getSnapshot().acknowledgedGeneration;
    this.adapter = new SpaceEditorAdapter({
      target: controller.session.key,
      window: controller.editorWindow(),
      maxBlocks: 100,
      maxDepth: 16,
      maxTextLength: 32768,
      maxClipboardBytes: 262144,
      allocateId,
      allocateOrder: allocateSpaceEditorOrder,
      canEdit: () => this.canEdit(),
      canChangeStructure: () => this.canStructure(),
      canUndo: () =>
        this.canStructure() &&
        this.#acknowledged === this.controller.session.getSnapshot().acknowledgedGeneration,
    });
  }
  setWritable(writable: boolean) {
    this.#writable = writable;
  }
  canEdit() {
    const { session, loading, error } = this.controller.getSnapshot();
    return (
      this.#writable &&
      !this.controller.structureBlocked() &&
      !loading &&
      error === null &&
      session.hydrated &&
      session.persistenceError === null &&
      session.status !== "conflict" &&
      session.status !== "uncertain" &&
      !session.recoveryReason &&
      !(session.history.action && !session.pending)
    );
  }
  canStructure() {
    return this.canEdit() && this.controller.session.getSnapshot().pending === null;
  }
  async compensate(direction: SpaceCompensation): Promise<boolean> {
    const reason = !this.canEdit()
      ? "Saved undo/redo requires edit permission and a resolved writable document."
      : this.controller.session.compensationAvailability(direction);
    if (reason) {
      this.#message(reason);
      return false;
    }
    try {
      return await this.controller.compensate(direction);
    } catch (error) {
      this.#message(error instanceof Error ? error.message : "Saved undo/redo could not be saved");
      throw error;
    }
  }
  getSnapshot = () => this.#notice;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #message(value: string) {
    this.#notice = value;
    for (const listener of this.#listeners) listener();
  }
  synchronize(state: EditorState): EditorState {
    if (this.#applying) return state;
    const snapshot = this.controller.session.getSnapshot();
    const window = this.controller.editorWindow();
    this.adapter.replaceWindow(window);
    const acknowledged = this.#acknowledged !== snapshot.acknowledgedGeneration;
    this.#acknowledged = snapshot.acknowledgedGeneration;
    const changed = !sameSpaceValue(spaceDocumentBlocks(state.doc), snapshot.blocks);
    if (!changed && !acknowledged) return state;
    const doc = changed ? spaceWindowDocument(window, 100, 16, state.schema) : state.doc;
    const selection = changed ? preserveSelection(state, doc) : state.selection;
    this.#message(
      acknowledged
        ? "Use saved undo/redo for the last supported save. Local undo restarts from the current draft."
        : "Another view or loaded window changed this document. Local undo restarts from the current content.",
    );
    return EditorState.create({
      schema: state.schema,
      doc,
      selection,
      storedMarks: state.storedMarks,
      plugins: state.plugins,
    });
  }
  apply(state: EditorState, transaction: Transaction) {
    const synchronized = this.synchronize(state);
    if (synchronized !== state)
      return { state: synchronized, transactions: [] as readonly Transaction[] };
    if (transaction.docChanged && !this.canEdit())
      return { state, transactions: [] as readonly Transaction[] };
    try {
      const result = state.applyTransaction(transaction);
      if (!result.transactions.includes(transaction)) return result;
      const mutations = this.adapter.changes(state.doc, result.transactions);
      for (const mutation of mutations)
        if (mutation.kind !== "delete") spaceJsonBytes(mutation.block, 32768);
      if (mutations.length) {
        this.#applying = true;
        try {
          this.controller.session.apply(
            mutations,
            spaceDocumentBlocks(result.state.doc).map((block) => block.id),
          );
        } finally {
          this.#applying = false;
        }
      }
      return result;
    } catch (error) {
      this.#message(error instanceof Error ? error.message : "This edit could not be applied");
      return { state, transactions: [] as readonly Transaction[] };
    }
  }
}
