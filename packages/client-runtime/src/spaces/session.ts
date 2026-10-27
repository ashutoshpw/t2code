import type {
  SpaceBlock,
  SpaceBlockId,
  SpaceBlockWindow,
  SpacePageTarget,
  SpaceReceiptEpoch,
  SpaceMutationAdmission,
} from "@t2code/contracts/spaces";

import { canEditSpaceBlock, isKnownSpaceBlock, isSpaceListItem } from "./values.ts";
import { decodeSpaceDocumentDraft, spaceDraftMaxBytes, spaceJsonBytes } from "./draft.ts";
import {
  acknowledgeSavedHistory,
  adoptHistoryWindow,
  emptySavedHistory,
  savedCompensation,
  type SpaceCompensation,
  type SpaceSavedHistory,
} from "./savedHistory.ts";

export type SpaceMutation =
  | { readonly kind: "insert"; readonly block: SpaceBlock }
  | { readonly kind: "replace"; readonly block: SpaceBlock }
  | { readonly kind: "delete"; readonly blockId: SpaceBlockId; readonly mergedInto?: SpaceBlockId };

export interface SpaceSaveRequest {
  readonly key: SpacePageTarget;
  readonly mutationId: string;
  // Missing only on legacy pending drafts, whose original intent cannot be reconstructed.
  readonly receiptEpoch?: SpaceReceiptEpoch;
  readonly baseRevision: number;
  readonly generation: number;
  readonly mutations: readonly SpaceMutation[];
}

export type SpaceSaveResult =
  | { readonly status: "saved"; readonly revision: number }
  | { readonly status: "conflict"; readonly revision: number };

export type SpaceReceiptResult =
  | SpaceSaveResult
  | { readonly status: "absent" }
  | { readonly status: "unknown" };

export interface SpaceSessionAdapter {
  readonly getMutationAdmission: () => Promise<SpaceMutationAdmission>;
  readonly validateNewRequest?: (request: SpaceSaveRequest) => void;
  readonly save: (request: SpaceSaveRequest) => Promise<SpaceSaveResult>;
  // "absent" must be authoritative; timeouts and expired receipt windows are "unknown".
  readonly lookupReceipt: (request: SpaceSaveRequest) => Promise<SpaceReceiptResult>;
}

export interface SpaceDocumentDraft {
  readonly version: 1;
  readonly key: SpacePageTarget;
  readonly baseRevision: number;
  readonly generation: number;
  readonly memberIds: readonly SpaceBlockId[];
  readonly blocks: readonly SpaceBlock[];
  readonly mutations: readonly SpaceMutation[];
  readonly pending: SpaceSaveRequest | null;
  readonly history?: SpaceSavedHistory;
}

export interface SpaceDraftStore {
  readonly load: (key: SpacePageTarget) => Promise<SpaceDocumentDraft | null>;
  // Implementations atomically replace this page's draft, including its pending receipt.
  readonly write: (key: SpacePageTarget, draft: SpaceDocumentDraft | null) => Promise<void>;
}

export interface SpaceSessionOptions {
  readonly assertMutable?: () => void;
  readonly adapter: SpaceSessionAdapter;
  readonly drafts: SpaceDraftStore;
  readonly createMutationId: () => string;
  readonly maxLoadedBlocks: number;
  readonly maxMutations: number;
}

export interface SpaceSessionSnapshot {
  readonly hydrated: boolean;
  readonly baseRevision: number | null;
  readonly generation: number;
  readonly blocks: readonly SpaceBlock[];
  readonly memberIds: readonly SpaceBlockId[];
  readonly dirty: boolean;
  readonly status: "loading" | "saved" | "draft" | "saving" | "uncertain" | "conflict";
  readonly pending: SpaceSaveRequest | null;
  readonly conflictRevision: number | null;
  readonly recoveryReason: "legacy-epoch-missing" | null;
  readonly acknowledgedGeneration: number | null;
  readonly persistenceError: unknown;
  readonly history: SpaceSavedHistory;
}

function own<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((item: unknown) => own(item))) as T;
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, own(item)])),
    ) as T;
  }
  return value;
}

function validateWindow(blocks: readonly SpaceBlock[], max: number) {
  if (blocks.length > max) throw new Error("Loaded block window exceeds limit");
  const byId = new Map(blocks.map((block) => [block.id, block]));
  if (byId.size !== blocks.length) throw new Error("Duplicate block ID");
  for (const block of blocks) {
    const seen = new Set([block.id]);
    let parentId = block.parentId;
    while (parentId !== null) {
      if (seen.has(parentId)) throw new Error("Block parent cycle");
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (isKnownSpaceBlock(parent) && !isSpaceListItem(parent))
        throw new Error("Only list items contain blocks");
      parentId = parent.parentId;
    }
  }
}

export class SpaceDocumentSession {
  readonly key: SpacePageTarget;
  readonly #options: SpaceSessionOptions;
  readonly #listeners = new Set<() => void>();
  #snapshot: SpaceSessionSnapshot = own({
    hydrated: false,
    baseRevision: null,
    generation: 0,
    blocks: [],
    memberIds: [],
    dirty: false,
    status: "loading",
    pending: null,
    conflictRevision: null,
    recoveryReason: null,
    acknowledgedGeneration: null,
    persistenceError: null,
    history: emptySavedHistory,
  });
  #mutations: readonly SpaceMutation[] = [];
  #hydration: Promise<void> | null = null;
  #persistence: Promise<void> | null = null;
  #queuedDraft: SpaceDocumentDraft | null | undefined;
  #saving: Promise<void> | null = null;

  constructor(key: SpacePageTarget, options: SpaceSessionOptions) {
    if (
      !Number.isSafeInteger(options.maxLoadedBlocks) ||
      options.maxLoadedBlocks < 1 ||
      !Number.isSafeInteger(options.maxMutations) ||
      options.maxMutations < 1
    )
      throw new Error("Session limits must be positive integers");
    this.key = own(key);
    this.#options = options;
  }

  getSnapshot = (): SpaceSessionSnapshot => this.#snapshot;

  canRelease(): boolean {
    return (
      this.#snapshot.hydrated &&
      !this.#snapshot.dirty &&
      !this.#snapshot.pending &&
      this.#snapshot.persistenceError === null &&
      !this.#saving &&
      this.#persistence === null &&
      this.#listeners.size === 0
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #update(patch: Partial<SpaceSessionSnapshot>) {
    if (
      Object.entries(patch).every(([key, value]) =>
        Object.is(this.#snapshot[key as keyof SpaceSessionSnapshot], value),
      )
    )
      return;
    if (patch.history && patch.history !== this.#snapshot.history)
      patch = { ...patch, history: own(patch.history) };
    this.#snapshot = Object.freeze({ ...this.#snapshot, ...patch });
    for (const listener of this.#listeners) listener();
  }

  hydrate(window: SpaceBlockWindow): Promise<void> {
    if (this.#hydration) return this.#hydration;
    const initial = own(window);
    validateWindow(initial.blocks, this.#options.maxLoadedBlocks);
    this.#hydration = this.#options.drafts
      .load(this.key)
      .then((stored) => {
        const draft =
          stored === null ? null : decodeSpaceDocumentDraft(stored, this.key, this.#options);
        if (draft) {
          validateWindow(draft.blocks, this.#options.maxLoadedBlocks);
          this.#mutations = own(draft.mutations);
          this.#update(
            own({
              hydrated: true,
              baseRevision: draft.baseRevision,
              generation: draft.generation,
              blocks: draft.blocks,
              memberIds: draft.memberIds,
              dirty: draft.mutations.length > 0,
              pending: draft.pending,
              recoveryReason:
                draft.pending && !draft.pending.receiptEpoch ? "legacy-epoch-missing" : null,
              status: draft.pending
                ? "uncertain"
                : draft.baseRevision !== initial.revision
                  ? "conflict"
                  : draft.mutations.length
                    ? "draft"
                    : "saved",
              conflictRevision: draft.baseRevision !== initial.revision ? initial.revision : null,
              persistenceError: null,
              history: draft.history ?? {
                ...emptySavedHistory,
                reason: "This restored draft has no retained saved preimage.",
              },
            }),
          );
        } else {
          this.#update({
            hydrated: true,
            baseRevision: initial.revision,
            blocks: initial.blocks,
            memberIds: own(initial.blocks.map((block) => block.id)),
            status: "saved",
            persistenceError: null,
            history: adoptHistoryWindow(emptySavedHistory, initial.blocks),
          });
        }
      })
      .catch((error: unknown) => {
        this.#hydration = null;
        this.#update({ persistenceError: error });
        throw error;
      });
    return this.#hydration;
  }

  #draft(): SpaceDocumentDraft | null {
    const snapshot = this.#snapshot;
    if (
      !snapshot.dirty &&
      !snapshot.pending &&
      !snapshot.history.undo &&
      !snapshot.history.redo &&
      !snapshot.history.reason
    )
      return null;
    return Object.freeze({
      version: 1,
      key: this.key,
      baseRevision: snapshot.baseRevision!,
      generation: snapshot.generation,
      blocks: snapshot.blocks,
      memberIds: snapshot.memberIds,
      mutations: this.#mutations,
      pending: snapshot.pending,
      history: snapshot.history,
    });
  }

  #persist(): Promise<void> {
    this.#queuedDraft = this.#draft();
    this.#persistence ??= Promise.resolve().then(() => this.#writeDrafts());
    return this.#persistence;
  }

  async #writeDrafts(): Promise<void> {
    // Keep only the latest queued generation while a durable write is in flight.
    while (this.#queuedDraft !== undefined) {
      const draft = this.#queuedDraft;
      this.#queuedDraft = undefined;
      try {
        await this.#options.drafts.write(this.key, draft);
        this.#update({ persistenceError: null });
      } catch (error) {
        this.#update({ persistenceError: error });
      }
    }
    this.#persistence = null;
  }

  async persistDraft(): Promise<void> {
    this.#assertHydrated();
    await this.#persist();
    if (this.#snapshot.persistenceError !== null) throw this.#snapshot.persistenceError;
  }

  #assertHydrated() {
    if (!this.#snapshot.hydrated) throw new Error("Hydrate the document before editing");
  }

  apply(mutations: readonly SpaceMutation[], order?: readonly SpaceBlockId[]): void {
    this.#apply(mutations, order);
  }

  structureAvailability(): string | null {
    const state = this.#snapshot;
    return !state.hydrated ||
      state.dirty ||
      state.pending ||
      this.#saving ||
      this.#persistence ||
      state.persistenceError !== null ||
      state.status !== "saved"
      ? "Resolve or finish loading the document before changing page placement"
      : null;
  }

  compensationAvailability(direction: SpaceCompensation): string | null {
    const state = this.#snapshot;
    if (
      !state.hydrated ||
      state.dirty ||
      state.pending ||
      this.#saving ||
      state.status !== "saved" ||
      state.persistenceError !== null
    )
      return "Resolve or save the current draft before saved undo/redo.";
    if (!state.history.base)
      return state.history.reason ?? "No saved compensation baseline is retained.";
    return savedCompensation(state.history, direction, state.blocks, state.baseRevision).reason;
  }

  prepareCompensation(direction: SpaceCompensation): void {
    const reason = this.compensationAvailability(direction);
    if (reason) throw new Error(reason);
    const { mutations } = savedCompensation(
      this.#snapshot.history,
      direction,
      this.#snapshot.blocks,
      this.#snapshot.baseRevision,
    );
    this.#apply(mutations, undefined, direction);
  }

  #apply(
    mutations: readonly SpaceMutation[],
    order?: readonly SpaceBlockId[],
    compensation?: SpaceCompensation,
  ): void {
    this.#options.assertMutable?.();
    this.#assertHydrated();
    if (this.#snapshot.history.action && !this.#snapshot.pending && !compensation)
      throw new Error("Finish saving or discard the prepared saved compensation before editing");
    if (mutations.length === 0) return;
    const owned = own(mutations);
    let blocks = [...this.#snapshot.blocks];
    const reserved = new Set([...this.#snapshot.memberIds, ...blocks.map((block) => block.id)]);
    for (const mutation of owned) {
      const id = mutation.kind === "delete" ? mutation.blockId : mutation.block.id;
      const index = blocks.findIndex((block) => block.id === id);
      if (mutation.kind === "insert") {
        const unsent = this.#mutations.slice(this.#snapshot.pending?.mutations.length ?? 0);
        const previous = unsent.findLast(
          (item) => (item.kind === "delete" ? item.blockId : item.block.id) === id,
        );
        if (index >= 0 || (reserved.has(id) && previous?.kind !== "delete"))
          throw new Error("Insert requires a fresh block ID");
        if (!canEditSpaceBlock(mutation.block))
          throw new Error("Cannot insert opaque content as a copy");
        if (
          mutation.block.parentId !== null &&
          !blocks.some((block) => block.id === mutation.block.parentId && isSpaceListItem(block))
        )
          throw new Error("New parent must be a loaded list item");
        reserved.add(id);
        blocks.push(mutation.block);
      } else {
        if (index < 0) throw new Error("Mutation targets an unloaded block");
        if (mutation.kind === "delete") {
          if (
            mutation.mergedInto &&
            (mutation.mergedInto === id ||
              !blocks.some((block) => block.id === mutation.mergedInto))
          )
            throw new Error("Merge target must be a different loaded block");
          blocks.splice(index, 1);
        } else {
          if (!canEditSpaceBlock(blocks[index]!) || !canEditSpaceBlock(mutation.block))
            throw new Error("Opaque blocks are read-only");
          const oldParent = blocks[index]!.parentId;
          if (
            mutation.block.parentId !== oldParent &&
            mutation.block.parentId !== null &&
            !blocks.some((block) => block.id === mutation.block.parentId && isSpaceListItem(block))
          )
            throw new Error("New parent must be a loaded list item");
          blocks[index] = mutation.block;
        }
      }
    }
    if (
      blocks.some(
        (block) =>
          block.parentId !== null &&
          reserved.has(block.parentId) &&
          !blocks.some((parent) => parent.id === block.parentId),
      )
    )
      throw new Error("Explicitly move or delete loaded children with their parent");
    validateWindow(blocks, this.#options.maxLoadedBlocks);
    const sentCount = this.#snapshot.pending?.mutations.length ?? 0;
    const prefix = this.#mutations.slice(0, sentCount);
    const members = new Set(this.#snapshot.memberIds);
    for (const mutation of prefix) {
      if (mutation.kind === "insert") members.add(mutation.block.id);
      if (mutation.kind === "delete") members.delete(mutation.blockId);
    }
    const intents = new Map<
      SpaceBlockId,
      { block: SpaceBlock | null; inserted?: SpaceBlock; mergedInto?: SpaceBlockId }
    >();
    for (const mutation of [...this.#mutations.slice(sentCount), ...owned]) {
      const id = mutation.kind === "delete" ? mutation.blockId : mutation.block.id;
      const previous = intents.get(id);
      if (mutation.kind === "delete")
        intents.set(id, {
          block: null,
          ...(previous?.inserted ? { inserted: previous.inserted } : {}),
          ...(mutation.mergedInto ? { mergedInto: mutation.mergedInto } : {}),
        });
      else
        intents.set(id, {
          block: mutation.block,
          ...(!members.has(id) ? { inserted: mutation.block } : {}),
        });
    }
    const nextMutations = [...prefix];
    for (const [id, intent] of intents) {
      if (intent.block)
        nextMutations.push({ kind: members.has(id) ? "replace" : "insert", block: intent.block });
      else {
        let into = intent.mergedInto;
        const visited = new Set([id]);
        while (into && intents.get(into)?.block === null) {
          if (visited.has(into)) throw new Error("Local merge cycle");
          visited.add(into);
          into = intents.get(into)?.mergedInto;
        }
        // Unsent identities may already be referenced by the draft or clipboard history.
        if (!members.has(id) && !intent.inserted) continue;
        if (!members.has(id)) nextMutations.push({ kind: "insert", block: intent.inserted! });
        nextMutations.push({ kind: "delete", blockId: id, ...(into ? { mergedInto: into } : {}) });
      }
    }
    if (order) {
      const byId = new Map(blocks.map((block) => [block.id, block]));
      if (
        order.length !== blocks.length ||
        new Set(order).size !== blocks.length ||
        order.some((id) => !byId.has(id))
      )
        throw new Error("Editor order must contain exactly the loaded blocks");
      blocks = order.map((id) => byId.get(id)!);
    }
    if (nextMutations.length > this.#options.maxMutations)
      throw new Error("Mutation window exceeds limit");
    const history = compensation
      ? { ...this.#snapshot.history, action: compensation }
      : this.#snapshot.history;
    spaceJsonBytes(
      {
        version: 1,
        key: this.key,
        baseRevision: this.#snapshot.baseRevision,
        generation: this.#snapshot.generation + 1,
        memberIds: this.#snapshot.memberIds,
        blocks,
        mutations: nextMutations,
        pending: this.#snapshot.pending,
        history,
      },
      spaceDraftMaxBytes,
    );
    this.#mutations = Object.freeze(nextMutations);
    this.#update({
      blocks: Object.freeze(blocks),
      generation: this.#snapshot.generation + 1,
      dirty: nextMutations.length > 0,
      history,
      status:
        this.#snapshot.status === "saved" || this.#snapshot.status === "draft"
          ? nextMutations.length
            ? "draft"
            : "saved"
          : this.#snapshot.status,
    });
    void this.#persist();
  }

  replaceWindow(window: SpaceBlockWindow): void {
    this.#assertHydrated();
    if (
      this.#snapshot.dirty ||
      this.#snapshot.pending ||
      this.#saving ||
      this.#snapshot.persistenceError !== null
    )
      throw new Error("Resolve the draft before replacing its loaded window");
    validateWindow(window.blocks, this.#options.maxLoadedBlocks);
    this.#update({
      baseRevision: window.revision,
      blocks: own(window.blocks),
      memberIds: own(window.blocks.map((block) => block.id)),
      status: "saved",
      conflictRevision: null,
      history: adoptHistoryWindow(this.#snapshot.history, window.blocks),
    });
  }

  save(): Promise<void> {
    this.#options.assertMutable?.();
    this.#assertHydrated();
    if (this.#saving) return this.#saving;
    this.#saving = Promise.resolve()
      .then(() => this.#save())
      .finally(() => {
        this.#saving = null;
      });
    return this.#saving;
  }

  async #save(): Promise<void> {
    this.#options.assertMutable?.();
    if (this.#snapshot.status === "conflict") throw new Error("Resolve the conflict before saving");
    if (!this.#snapshot.dirty && !this.#snapshot.pending) return;
    let request = this.#snapshot.pending;
    const createdRequest = request === null;
    // Only an in-process persistence failure can leave compensation known unsent; reloads are uncertain.
    const unsentCompensation =
      request && this.#snapshot.history.action && this.#snapshot.status === "draft";
    if (request && !unsentCompensation) {
      this.#update({ status: "uncertain" });
      if (!request.receiptEpoch) return;
      const receipt = await this.#options.adapter.lookupReceipt(request);
      if (receipt.status === "unknown") return;
      if (receipt.status !== "absent") {
        await this.#acknowledge(request, receipt);
        return;
      }
    } else if (!request) {
      const admission = await this.#options.adapter.getMutationAdmission();
      if (!admission.epoch) throw new Error("Missing Spaces mutation admission");
      if (this.getSnapshot().status === "conflict")
        throw new Error("Resolve the conflict before saving");
      if (!this.#snapshot.dirty) return;
      const mutationId = this.#options.createMutationId();
      if (!mutationId) throw new Error("Mutation ID must not be empty");
      request = own({
        key: this.key,
        mutationId,
        receiptEpoch: admission.epoch,
        baseRevision: this.#snapshot.baseRevision!,
        generation: this.#snapshot.generation,
        mutations: this.#mutations,
      });
      this.#options.adapter.validateNewRequest?.(request);
      this.#update({ pending: request });
    }
    try {
      await this.persistDraft();
    } catch (error) {
      if (createdRequest) {
        this.#update({ pending: this.#snapshot.history.action ? request : null, status: "draft" });
        await this.#persist();
      }
      throw error;
    }
    this.#update({ status: "saving" });
    try {
      const result = await this.#options.adapter.save(request);
      await this.#acknowledge(request, result);
    } catch (error) {
      this.#update({ status: "uncertain" });
      await this.#persist();
      throw error;
    }
  }

  async #acknowledge(request: SpaceSaveRequest, result: SpaceSaveResult) {
    if (result.status === "conflict") {
      this.#update({ status: "conflict", conflictRevision: result.revision, pending: null });
    } else {
      this.#mutations = Object.freeze(this.#mutations.slice(request.mutations.length));
      let history = acknowledgeSavedHistory(
        this.#snapshot.history,
        request.mutations,
        result.revision,
        this.#snapshot.blocks,
        this.#mutations.length > 0,
      );
      const members = new Set(this.#snapshot.memberIds);
      for (const mutation of request.mutations) {
        if (mutation.kind === "insert") members.add(mutation.block.id);
        if (mutation.kind === "delete") members.delete(mutation.blockId);
      }
      try {
        spaceJsonBytes(
          {
            version: 1,
            key: this.key,
            baseRevision: result.revision,
            generation: this.#snapshot.generation,
            blocks: this.#snapshot.blocks,
            memberIds: [...members],
            mutations: this.#mutations,
            pending: null,
            history,
          },
          spaceDraftMaxBytes,
        );
      } catch {
        history = {
          ...emptySavedHistory,
          reason: "Saved history exceeds the atomic draft budget. Your newer draft is retained.",
        };
      }
      this.#update({
        baseRevision: result.revision,
        acknowledgedGeneration: request.generation,
        memberIds: own([...members]),
        pending: null,
        dirty: this.#mutations.length > 0,
        status: this.#mutations.length > 0 ? "draft" : "saved",
        conflictRevision: null,
        history,
      });
    }
    await this.#persist();
  }

  async discardDraft(window: SpaceBlockWindow): Promise<void> {
    this.#options.assertMutable?.();
    this.#assertHydrated();
    if (this.#saving || this.#snapshot.pending)
      throw new Error("Resolve the pending receipt before discarding");
    validateWindow(window.blocks, this.#options.maxLoadedBlocks);
    this.#mutations = Object.freeze([]);
    this.#update({
      baseRevision: window.revision,
      blocks: own(window.blocks),
      memberIds: own(window.blocks.map((block) => block.id)),
      dirty: false,
      pending: null,
      status: "saved",
      conflictRevision: null,
      history: adoptHistoryWindow(emptySavedHistory, window.blocks),
    });
    await this.persistDraft();
  }
}

export class SpaceDocumentSessionRegistry {
  readonly #sessions = new Map<string, SpaceDocumentSession>();

  get(key: SpacePageTarget, options: SpaceSessionOptions): SpaceDocumentSession {
    const id = JSON.stringify([key.environmentId, key.pageId]);
    let session = this.#sessions.get(id);
    if (!session) {
      session = new SpaceDocumentSession(key, options);
      this.#sessions.set(id, session);
    }
    return session;
  }

  release(key: SpacePageTarget): boolean {
    const id = JSON.stringify([key.environmentId, key.pageId]);
    const session = this.#sessions.get(id);
    if (!session) return true;
    if (!session.canRelease()) return false;
    return this.#sessions.delete(id);
  }
}
