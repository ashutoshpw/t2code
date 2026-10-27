import type { SpaceBlockId, SpaceBlockWindow } from "@t2code/contracts/spaces";
import {
  isKnownSpaceBlock,
  spaceJsonBytes,
  type SpaceDocumentSession,
} from "@t2code/client-runtime/spaces";
import { SpacesNativePublication } from "./nativeSpacesPublication";
import { nativeDocumentForSpaceBlock } from "./nativeSpacesAdapter";
import type { SpacesReadAccess } from "./reader";

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
      this.#snapshot.busy === "persist" ||
      this.#snapshot.busy === "discard"
    )
      throw new Error("Resolve the conflict or local storage error before editing");
    return access;
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
        spaceJsonBytes(replacement, access.capability!.limits.maxBlockBytes);
        session.apply([{ kind: "replace", block: replacement }]);
        focus.generation = session.getSnapshot().generation;
      }),
    };
    this.#stopPublication = focus.publication.subscribe(() => this.#update({}));
    this.#update({ focus, error: null });
    return focus;
  }

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
    spaceJsonBytes(replacement, access.capability!.limits.maxBlockBytes);
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
