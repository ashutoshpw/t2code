import type { SpaceBlock, SpaceBlockId, SpaceBlockWindow } from "@t2code/contracts/spaces";
import {
  isKnownSpaceBlock,
  spaceJsonBytes,
  savedCompensation,
  type SpaceCompensation,
  type SpaceDocumentSession,
  type SpaceMutation,
  type SpaceSessionSnapshot,
} from "@t2code/client-runtime/spaces";
import { SpacesNativePublication } from "./nativeSpacesPublication";
import { canRestoreMobileSpaceBlock, nativeDocumentForSpaceBlock } from "./nativeSpacesAdapter";
import type { SpacesReadAccess } from "./reader";
import { allocateMobileSpaceRootOrder } from "./imageInsertion";

export type MobileCoreBlockKind =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulleted_item"
  | "numbered_item"
  | "todo_item"
  | "divider";

interface CoreDeletionPlan {
  readonly state: SpaceSessionSnapshot;
  readonly rootId: SpaceBlockId;
  readonly ids: readonly SpaceBlockId[];
  readonly label: string;
  readonly current: () => boolean;
}

function deletableCore(block: SpaceBlock) {
  return (
    nativeDocumentForSpaceBlock(block) !== null ||
    (isKnownSpaceBlock(block) && block.type === "divider")
  );
}

interface FocusedBlock {
  readonly owner: symbol;
  readonly token: number;
  readonly blockId: SpaceBlockId;
  readonly publication: SpacesNativePublication;
  generation: number;
}

interface EditingSnapshot {
  readonly focus: FocusedBlock | null;
  readonly busy: "save" | "discard" | "persist" | null;
  readonly error: string | null;
}

export class MobileSpaceEditing {
  readonly #listeners = new Set<() => void>();
  #stopPublication: (() => void) | null = null;
  #token = 0;
  #snapshot: EditingSnapshot = { focus: null, busy: null, error: null };

  constructor(
    readonly ports: {
      readonly session: SpaceDocumentSession;
      readonly access: () => SpacesReadAccess;
      readonly readWindow: () => Promise<SpaceBlockWindow>;
      readonly assertMutable?: () => void;
      readonly completeWindow?: () => boolean;
    },
  ) {}

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #update(patch: Partial<EditingSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #mutable() {
    const access = this.ports.access();
    if (access.availability !== "writable" || access.capability?.version !== 2 || !access.current())
      throw new Error("Reconnect with current Spaces read and operate permission to edit");
    if (!this.ports.session.getSnapshot().hydrated)
      throw new Error("Wait for the local draft to finish loading");
    this.ports.assertMutable?.();
    return access;
  }
  #editable() {
    const access = this.#mutable();
    const state = this.ports.session.getSnapshot();
    if (
      state.status === "conflict" ||
      state.persistenceError !== null ||
      (state.history.action && !state.pending) ||
      this.#snapshot.busy === "persist" ||
      this.#snapshot.busy === "discard"
    )
      throw new Error("Resolve the conflict or local storage error before editing");
    return access;
  }

  #coreReady(current: () => boolean) {
    if (!current()) throw new Error("The page source changed; choose the action again");
    const access = this.#editable();
    const state = this.ports.session.getSnapshot();
    if (this.#snapshot.focus) throw new Error("Finish the active native input first");
    if (this.#snapshot.busy || state.pending || state.recoveryReason || state.status === "saving")
      throw new Error("Finish the pending page operation before adding or deleting blocks");
    if (state.baseRevision === null || !this.ports.completeWindow?.())
      throw new Error(
        "Use First / refresh to load a complete page before adding or deleting blocks",
      );
    return access;
  }

  coreAvailability(current: () => boolean): string | null {
    try {
      this.#coreReady(current);
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : "Core block actions are unavailable";
    }
  }

  canDeleteCoreBlock(blockId: SpaceBlockId) {
    const block = this.ports.session.getSnapshot().blocks.find((item) => item.id === blockId);
    return !!block && deletableCore(block);
  }

  async insertCore(kind: MobileCoreBlockKind, id: SpaceBlockId, current: () => boolean) {
    const access = this.#coreReady(current);
    const state = this.ports.session.getSnapshot();
    if (state.blocks.length >= Math.min(100, access.capability!.limits.maxPageBlocks))
      throw new Error("This complete page has no room for another mobile block");
    const base = {
      id,
      parentId: null,
      version: 1,
      order: allocateMobileSpaceRootOrder(
        state.blocks.findLast((b) => b.parentId === null)?.order ?? null,
      ),
    } as const;
    let block: SpaceBlock;
    switch (kind) {
      case "heading1":
      case "heading2":
      case "heading3":
        block = { ...base, type: "heading", content: { level: Number(kind.at(-1)), runs: [] } };
        break;
      case "todo_item":
        block = { ...base, type: kind, content: { checked: false, runs: [] } };
        break;
      case "divider":
        block = { ...base, type: kind, content: {} };
        break;
      case "paragraph":
      case "bulleted_item":
      case "numbered_item":
        block = { ...base, type: kind, content: { runs: [] } };
        break;
      default:
        throw new Error("Unsupported native core block kind");
    }
    await this.#applyCore([{ kind: "insert", block }], access);
  }

  prepareCoreDeletion(rootId: SpaceBlockId, current: () => boolean): CoreDeletionPlan {
    const access = this.#coreReady(current);
    const state = this.ports.session.getSnapshot();
    const root = state.blocks.find((block) => block.id === rootId);
    if (!root) throw new Error("This block is not loaded");
    const ids = new Set([rootId]);
    for (let previous = 0; previous !== ids.size;) {
      previous = ids.size;
      for (const block of state.blocks)
        if (block.parentId !== null && ids.has(block.parentId)) ids.add(block.id);
    }
    const selected = state.blocks.filter((block) => ids.has(block.id));
    if (selected.some((block) => !deletableCore(block)))
      throw new Error(
        "This subtree contains read-only or unsupported content; original blocks retained",
      );
    if (ids.size > access.capability!.limits.maxMutationNodes)
      throw new Error("This subtree exceeds the current mutation budget");
    const text =
      isKnownSpaceBlock(root) && "runs" in root.content
        ? root.content.runs
            .map((run) => run.text)
            .join("")
            .slice(0, 80)
        : "";
    return Object.freeze({
      state,
      rootId,
      ids: Object.freeze(selected.map((block) => block.id)),
      label: `${root.type}${text ? `: ${text}` : ""}`,
      current,
    });
  }

  async deleteCore(plan: CoreDeletionPlan) {
    const access = this.#coreReady(plan.current);
    if (plan.state !== this.ports.session.getSnapshot())
      throw new Error("The page changed after confirmation; select the block again");
    const checked = this.prepareCoreDeletion(plan.rootId, plan.current);
    if (JSON.stringify(checked.ids) !== JSON.stringify(plan.ids))
      throw new Error("The selected subtree changed; select it again");
    await this.#applyCore(
      plan.ids.map((blockId) => ({ kind: "delete", blockId })),
      access,
    );
  }

  async #applyCore(mutations: readonly SpaceMutation[], access: SpacesReadAccess) {
    for (const mutation of mutations)
      if (mutation.kind !== "delete")
        spaceJsonBytes(mutation.block, access.capability!.limits.maxBlockBytes);
    if (mutations.length > access.capability!.limits.maxMutationNodes)
      throw new Error("This change exceeds the current mutation budget");
    spaceJsonBytes({ mutations }, access.capability!.limits.maxMutationBytes);
    this.ports.session.apply(mutations);
    this.#update({ busy: "persist", error: null });
    try {
      await this.ports.session.persistDraft();
    } catch (cause) {
      this.#update({
        error: cause instanceof Error ? cause.message : "Could not retain the draft",
      });
      throw cause;
    } finally {
      this.#update({ busy: null });
    }
  }

  focus(owner: symbol, blockId: SpaceBlockId) {
    this.#editable();
    if (this.#snapshot.focus) throw new Error("Finish the active block before editing another");
    const session = this.ports.session;
    const block = session.getSnapshot().blocks.find((item) => item.id === blockId);
    if (!block) throw new Error("This block is not loaded");
    const focus: FocusedBlock = {
      owner,
      token: ++this.#token,
      blockId,
      generation: session.getSnapshot().generation,
      publication: new SpacesNativePublication(block, (replacement) => {
        const access = this.#editable();
        if (this.#snapshot.focus !== focus || session.getSnapshot().generation !== focus.generation)
          throw new Error("The page changed outside this native input; your input is retained");
        this.#replacementBudget(replacement, access);
        session.apply([{ kind: "replace", block: replacement }]);
        focus.generation = session.getSnapshot().generation;
      }),
    };
    this.#stopPublication = focus.publication.subscribe(() => this.#update({}));
    this.#update({ focus, error: null });
    return focus;
  }

  assertFocused(owner: symbol, token: number) {
    this.#editable();
    const focus = this.#snapshot.focus;
    if (
      !focus ||
      focus.owner !== owner ||
      focus.token !== token ||
      focus.generation !== this.ports.session.getSnapshot().generation
    )
      throw new Error("This native input no longer owns the block");
  }

  #replacementBudget(
    block: import("@t2code/contracts/spaces").SpaceBlock,
    access: SpacesReadAccess,
  ) {
    spaceJsonBytes(block, access.capability!.limits.maxBlockBytes);
    spaceJsonBytes(
      { mutations: [{ kind: "replace", block }] },
      access.capability!.limits.maxMutationBytes,
    );
  }

  #savedReason(direction: SpaceCompensation): string | null {
    const access = this.#mutable();
    if (this.#snapshot.focus)
      return "Finish the active native input before saved content Undo/Redo";
    const session = this.ports.session;
    const reason = session.compensationAvailability(direction);
    if (reason) return reason;
    const state = session.getSnapshot();
    const plan = savedCompensation(state.history, direction, state.blocks, state.baseRevision);
    for (const mutation of plan.mutations) {
      const current =
        mutation.kind === "replace"
          ? state.blocks.find((block) => block.id === mutation.block.id)
          : null;
      if (
        mutation.kind !== "replace" ||
        !current ||
        !canRestoreMobileSpaceBlock(current, mutation.block)
      )
        return "This saved change includes content or attributes that are read-only on mobile";
      this.#replacementBudget(mutation.block, access);
    }
    spaceJsonBytes({ mutations: plan.mutations }, access.capability!.limits.maxMutationBytes);
    return null;
  }

  compensationAvailability(direction: SpaceCompensation): string | null {
    if (this.#snapshot.busy) return "Wait for the current page operation";
    try {
      return this.#savedReason(direction);
    } catch (cause) {
      return cause instanceof Error ? cause.message : "Saved content Undo/Redo is unavailable";
    }
  }

  compensate = (direction: SpaceCompensation) =>
    this.#run("save", async () => {
      const reason = this.#savedReason(direction);
      if (reason) throw new Error(reason);
      this.ports.session.prepareCompensation(direction);
      await this.ports.session.persistDraft();
      this.#mutable();
      await this.ports.session.save();
    });

  async finish(owner: symbol, token: number) {
    const focus = this.#snapshot.focus;
    if (!focus || focus.owner !== owner || focus.token !== token)
      throw new Error("This native input no longer owns the block");
    const state = focus.publication.getSnapshot();
    if (state.blocked || state.observed.composing)
      throw new Error("Finish composition or recover the unpublished native input first");
    await this.ports.session.persistDraft();
    if (this.#snapshot.focus !== focus) throw new Error("The active block changed");
    const latest = focus.publication.getSnapshot();
    if (
      latest.blocked ||
      latest.observed.composing ||
      latest.observed.revision !== state.observed.revision
    )
      throw new Error("Native input changed while retaining the draft; finish it again");
    this.#stopPublication?.();
    this.#stopPublication = null;
    this.#update({ focus: null, error: null });
  }

  toggleTodo(blockId: SpaceBlockId) {
    const access = this.#editable();
    if (this.#snapshot.focus)
      throw new Error("Finish the active text input before toggling a to-do");
    const block = this.ports.session.getSnapshot().blocks.find((item) => item.id === blockId);
    if (
      !block ||
      !nativeDocumentForSpaceBlock(block) ||
      !isKnownSpaceBlock(block) ||
      block.type !== "todo_item"
    )
      throw new Error("This to-do is read-only on mobile");
    const replacement = {
      ...block,
      content: { ...block.content, checked: !block.content.checked },
    };
    this.#replacementBudget(replacement, access);
    this.ports.session.apply([{ kind: "replace", block: replacement }]);
  }

  async #run(busy: NonNullable<EditingSnapshot["busy"]>, action: () => Promise<void>) {
    if (this.#snapshot.busy) return;
    this.#update({ busy, error: null });
    try {
      await action();
    } catch (cause) {
      this.#update({ error: cause instanceof Error ? cause.message : "Could not update the page" });
    } finally {
      this.#update({ busy: null });
    }
  }
  save = () =>
    this.#run("save", async () => {
      this.#mutable();
      if (this.#snapshot.focus)
        throw new Error("Finish the active native input before saving or retrying its receipt");
      if (this.ports.session.getSnapshot().recoveryReason)
        throw new Error(
          "This older pending request cannot be reconstructed; the draft is retained",
        );
      await this.ports.session.save();
    });
  retryPersistence = () => this.#run("persist", () => this.ports.session.persistDraft());
  discardInput = (owner: symbol, token: number) =>
    this.#run("persist", async () => {
      const access = this.#mutable();
      const focus = this.#snapshot.focus;
      if (!focus || focus.owner !== owner || focus.token !== token)
        throw new Error("This native input no longer owns the block");
      if (this.ports.session.getSnapshot().pending)
        throw new Error("Resolve the pending receipt before discarding native input");
      await this.ports.session.persistDraft();
      this.#mutable();
      if (
        !access.current() ||
        this.#snapshot.focus !== focus ||
        this.ports.session.getSnapshot().pending
      )
        throw new Error("The page or connection changed; native input remains retained");
      this.#stopPublication?.();
      this.#stopPublication = null;
      this.#update({ focus: null });
    });
  discard = () =>
    this.#run("discard", async () => {
      const access = this.#mutable();
      const session = this.ports.session;
      const state = session.getSnapshot();
      if (this.#snapshot.focus || state.pending)
        throw new Error("Finish the input and resolve the exact pending receipt before discarding");
      const window = await this.ports.readWindow();
      this.#mutable();
      if (!access.current() || session.getSnapshot().generation !== state.generation)
        throw new Error(
          "The page or connection changed while preparing discard; your draft is retained",
        );
      await session.discardDraft(window);
    });
}
