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
}

export interface SpaceDraftStore {
  readonly load: (key: SpacePageTarget) => Promise<SpaceDocumentDraft | null>;
  // Implementations atomically replace this page's draft, including its pending receipt.
  readonly write: (key: SpacePageTarget, draft: SpaceDocumentDraft | null) => Promise<void>;
}

export interface SpaceSessionOptions {
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
  readonly persistenceError: unknown;
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
    persistenceError: null,
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
                  : "draft",
              conflictRevision: draft.baseRevision !== initial.revision ? initial.revision : null,
              persistenceError: null,
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
    if (!snapshot.dirty && !snapshot.pending) return null;
    return Object.freeze({
      version: 1,
      key: this.key,
      baseRevision: snapshot.baseRevision!,
      generation: snapshot.generation,
      blocks: snapshot.blocks,
      memberIds: snapshot.memberIds,
      mutations: this.#mutations,
      pending: snapshot.pending,
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

  apply(mutations: readonly SpaceMutation[]): void {
    this.#assertHydrated();
    if (mutations.length === 0) return;
    const owned = own(mutations);
    let blocks = [...this.#snapshot.blocks];
    const reserved = new Set([...this.#snapshot.memberIds, ...blocks.map((block) => block.id)]);
    for (const mutation of owned) {
      const id = mutation.kind === "delete" ? mutation.blockId : mutation.block.id;
      const index = blocks.findIndex((block) => block.id === id);
      if (mutation.kind === "insert") {
        if (reserved.has(id)) throw new Error("Insert requires a fresh block ID");
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
    const nextMutations = [...this.#mutations];
    const sentCount = this.#snapshot.pending?.mutations.length ?? 0;
    for (const mutation of owned) {
      const last = nextMutations.at(-1);
      if (
        mutation.kind === "replace" &&
        nextMutations.length > sentCount &&
        last &&
        last.kind !== "delete" &&
        last.block.id === mutation.block.id
      ) {
        nextMutations[nextMutations.length - 1] = { ...last, block: mutation.block };
      } else {
        nextMutations.push(mutation);
      }
    }
    if (nextMutations.length > this.#options.maxMutations)
      throw new Error("Mutation window exceeds limit");
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
      },
      spaceDraftMaxBytes,
    );
    this.#mutations = Object.freeze(nextMutations);
    this.#update({
      blocks: Object.freeze(blocks),
      generation: this.#snapshot.generation + 1,
      dirty: true,
      status: this.#snapshot.status === "saved" ? "draft" : this.#snapshot.status,
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
    });
  }

  save(): Promise<void> {
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
    if (this.#snapshot.status === "conflict") throw new Error("Resolve the conflict before saving");
    if (!this.#snapshot.dirty && !this.#snapshot.pending) return;
    let request = this.#snapshot.pending;
    const createdRequest = request === null;
    if (request) {
      this.#update({ status: "uncertain" });
      if (!request.receiptEpoch) return;
      const receipt = await this.#options.adapter.lookupReceipt(request);
      if (receipt.status === "unknown") return;
      if (receipt.status !== "absent") {
        await this.#acknowledge(request, receipt);
        return;
      }
    } else {
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
        this.#update({ pending: null, status: "draft" });
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
      const members = new Set(this.#snapshot.memberIds);
      for (const mutation of request.mutations) {
        if (mutation.kind === "insert") members.add(mutation.block.id);
        if (mutation.kind === "delete") members.delete(mutation.blockId);
      }
      this.#update({
        baseRevision: result.revision,
        memberIds: own([...members]),
        pending: null,
        dirty: this.#mutations.length > 0,
        status: this.#mutations.length > 0 ? "draft" : "saved",
        conflictRevision: null,
      });
    }
    await this.#persist();
  }

  async discardDraft(window: SpaceBlockWindow): Promise<void> {
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
