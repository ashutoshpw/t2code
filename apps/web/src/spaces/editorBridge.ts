import {
  EditorState,
  NodeSelection,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { SpaceBlockId, SpacePageTarget } from "@t2code/contracts/spaces";
import {
  isKnownSpaceBlock,
  mediaAssetId,
  spaceJsonBytes,
  type SpaceCompensation,
  type SpaceImageInsertion,
} from "@t2code/client-runtime/spaces";
import { SpaceEditorAdapter } from "./adapter";
import {
  canEditSpaceEditorBlock,
  sameSpaceValue,
  spaceDocumentBlocks,
  spaceWindowDocument,
} from "./document";
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
  #mediaWritable = false;
  #applying = false;
  #acknowledged: number | null;
  #notice: string | null = null;
  #navigationReveal: {
    view: object;
    target: string | null;
    pending: boolean;
  } | null = null;
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
      canEditMedia: () => this.canEditMedia(),
      canChangeStructure: () => this.canStructure(),
      canUndo: () =>
        this.canStructure() &&
        this.#acknowledged === this.controller.session.getSnapshot().acknowledgedGeneration,
    });
  }
  setWritable(writable: boolean, mediaWritable = writable) {
    this.#writable = writable;
    this.#mediaWritable = mediaWritable;
  }
  canEditMedia() {
    return this.#mediaWritable && this.canEdit();
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
  childPageTarget(id: SpaceBlockId) {
    const snapshot = this.controller.getSnapshot();
    const block = snapshot.session.blocks.find((block) => block.id === id);
    return !snapshot.loading &&
      !snapshot.error &&
      snapshot.session.hydrated &&
      block &&
      isKnownSpaceBlock(block) &&
      block.type === "child_page"
      ? block.content.pageId
      : null;
  }
  revealBlock(
    state: EditorState,
    target: SpacePageTarget & { blockId: SpaceBlockId },
    current: () => boolean,
  ): {
    status: "loaded" | "not-loaded" | "unavailable";
    transaction?: Transaction;
  } {
    const snapshot = this.controller.getSnapshot(),
      key = this.controller.session.key;
    if (
      !current() ||
      key.environmentId !== target.environmentId ||
      key.pageId !== target.pageId ||
      snapshot.loading ||
      snapshot.error ||
      !snapshot.session.hydrated ||
      !sameSpaceValue(spaceDocumentBlocks(state.doc), snapshot.session.blocks)
    )
      return { status: "unavailable" };
    let position: number | undefined;
    state.doc.descendants((node, pos) => {
      if (node.attrs.block?.id === target.blockId) position = pos;
    });
    if (position === undefined) return { status: "not-loaded" };
    return {
      status: "loaded",
      transaction: state.tr
        .setSelection(NodeSelection.create(state.doc, position))
        .setMeta("addToHistory", false)
        .scrollIntoView(),
    };
  }
  revealNavigation(
    view: object,
    state: EditorState,
    target: (SpacePageTarget & { blockId: SpaceBlockId }) | null,
    source: { current(): boolean } | null | undefined,
    current: () => boolean,
  ) {
    const identity = target
      ? JSON.stringify([target.environmentId, target.pageId, target.blockId])
      : null;
    if (
      !this.#navigationReveal ||
      this.#navigationReveal.view !== view ||
      this.#navigationReveal.target !== identity
    ) {
      this.#navigationReveal = { view, target: identity, pending: target !== null };
    }
    if (!target || !this.#navigationReveal.pending) return null;
    const result = this.revealBlock(state, target, () => source?.current() === true && current());
    if (result.status === "loaded") this.#navigationReveal.pending = false;
    return result;
  }
  imageInsertion(
    state: () => EditorState,
    dispatch: (transaction: Transaction) => void,
    current: () => boolean = () => true,
  ): SpaceImageInsertion {
    return {
      key: this.controller.session.key,
      current,
      state: () => this.controller.session.getSnapshot(),
      complete: () => this.controller.editorWindow().completeParents.includes(null),
      plan: (assetId, kind = "image") => {
        if (!current() || !this.canStructure())
          throw new Error("Resolve the current document before inserting an image");
        const snapshot = this.controller.session.getSnapshot();
        return {
          block: this.adapter.planImage(state(), assetId, kind),
          revision: snapshot.baseRevision!,
          generation: snapshot.generation,
          windowIds: snapshot.blocks.map((b) => b.id),
        };
      },
      captureReplacement: (blockId) => {
        const snapshot = this.controller.session.getSnapshot();
        const before = snapshot.blocks.find((b) => b.id === blockId);
        if (
          !current() ||
          !this.canEditMedia() ||
          !this.canStructure() ||
          !before ||
          !this.adapter.mediaTarget(state(), blockId) ||
          !mediaAssetId(before) ||
          !canEditSpaceEditorBlock(before) ||
          !snapshot.memberIds.includes(blockId) ||
          snapshot.baseRevision === null ||
          !this.controller.editorWindow().completeParents.includes(null) ||
          !sameSpaceValue(spaceDocumentBlocks(state().doc), snapshot.blocks)
        )
          throw new Error(
            "Replacement requires a current committed known media target and complete window",
          );
        return { before, revision: snapshot.baseRevision, generation: snapshot.generation };
      },
      planReplacement: (replacement, assetId, kind) => {
        const snapshot = this.controller.session.getSnapshot();
        if (
          !current() ||
          !this.canEditMedia() ||
          !this.canStructure() ||
          snapshot.baseRevision !== replacement.revision ||
          snapshot.generation !== replacement.generation ||
          !snapshot.blocks.some((b) => sameSpaceValue(b, replacement.before)) ||
          !isKnownSpaceBlock(replacement.before) ||
          !snapshot.memberIds.includes(replacement.before.id) ||
          !this.controller.editorWindow().completeParents.includes(null) ||
          !sameSpaceValue(spaceDocumentBlocks(state().doc), snapshot.blocks)
        )
          throw new Error(
            "Replacement target changed; original retained. Cancel or start a new explicit replacement",
          );
        return {
          block: {
            ...replacement.before,
            type: kind,
            content: { ...replacement.before.content, assetId },
          },
          revision: snapshot.baseRevision,
          generation: snapshot.generation,
          windowIds: snapshot.blocks.map((b) => b.id),
        };
      },
      applyReplacement: (placement, replacement) => {
        const snapshot = this.controller.session.getSnapshot();
        if (
          !current() ||
          !this.canEditMedia() ||
          snapshot.baseRevision !== placement.revision ||
          snapshot.generation !== placement.generation ||
          snapshot.pending ||
          !sameSpaceValue(
            snapshot.blocks.map((b) => b.id),
            placement.windowIds,
          ) ||
          !snapshot.blocks.some((b) => sameSpaceValue(b, replacement.before)) ||
          !this.adapter.replaceMedia(replacement.before, placement.block)(state(), dispatch) ||
          !this.controller.session
            .getSnapshot()
            .blocks.some((b) => sameSpaceValue(b, placement.block))
        )
          throw new Error("Replacement target is no longer valid; original retained");
      },
      persist: () => this.controller.session.persistDraft(),
      apply: (placement) => {
        const snapshot = this.controller.session.getSnapshot();
        if (
          !current() ||
          snapshot.baseRevision !== placement.revision ||
          snapshot.generation !== placement.generation ||
          !sameSpaceValue(
            snapshot.blocks.map((b) => b.id),
            placement.windowIds,
          ) ||
          !this.adapter.insertImage(placement.block)(state(), dispatch) ||
          !this.controller.session
            .getSnapshot()
            .blocks.some((b) => sameSpaceValue(b, placement.block))
        )
          throw new Error("Image placement is no longer valid; original is retained");
      },
    };
  }
  blockMoveSelection(state: EditorState) {
    const snapshot = this.controller.getSnapshot();
    if (
      !this.canEdit() ||
      this.controller.session.structureAvailability() ||
      !this.controller.editorWindow().completeParents.includes(null)
    )
      throw new Error("Block moves require a clean, current and complete loaded document");
    if (!sameSpaceValue(spaceDocumentBlocks(state.doc), snapshot.session.blocks))
      throw new Error("Synchronize the editor before selecting a block move");
    const selected = new Set<SpaceBlockId>();
    if (state.selection instanceof NodeSelection && state.selection.node.attrs.block?.id)
      selected.add(state.selection.node.attrs.block.id);
    if (!(state.selection instanceof NodeSelection))
      for (const point of [state.selection.$from, state.selection.$to]) {
        for (let depth = point.depth; depth > 0; depth--) {
          const id = point.node(depth).attrs.block?.id as SpaceBlockId | undefined;
          if (id) {
            selected.add(id);
            break;
          }
        }
      }
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
      if (
        node.attrs.block?.id &&
        pos >= state.selection.from &&
        pos + node.nodeSize <= state.selection.to
      )
        selected.add(node.attrs.block.id);
    });
    const byId = new Map(snapshot.session.blocks.map((b) => [b.id, b]));
    const blockIds = snapshot.session.blocks
      .filter((block) => {
        if (!selected.has(block.id)) return false;
        let parent = block.parentId;
        while (parent !== null) {
          if (selected.has(parent)) return false;
          parent = byId.get(parent)?.parentId ?? null;
        }
        return true;
      })
      .map((b) => b.id);
    if (!blockIds.length) throw new Error("Select at least one loaded block");
    return { revision: snapshot.session.baseRevision!, blockIds };
  }
  compensationUsesMedia(direction: SpaceCompensation) {
    const change = this.controller.session.getSnapshot().history[direction];
    return (
      !!change &&
      change.before.some(
        (before) =>
          mediaAssetId(before) &&
          !sameSpaceValue(
            before,
            change.after.find((after) => after.id === before.id),
          ),
      )
    );
  }
  async compensate(direction: SpaceCompensation): Promise<boolean> {
    const reason = !this.canEdit()
      ? "Saved undo/redo requires edit permission and a resolved writable document."
      : this.compensationUsesMedia(direction) && !this.canEditMedia()
        ? "Saved media undo/redo requires current asset support and edit permission."
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
    this.adapter.clearMediaHistory();
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
      if (
        this.#navigationReveal &&
        (transaction.docChanged || !state.selection.eq(result.state.selection))
      )
        this.#navigationReveal.pending = false;
      return result;
    } catch (error) {
      this.#message(error instanceof Error ? error.message : "This edit could not be applied");
      return { state, transactions: [] as readonly Transaction[] };
    }
  }
}
