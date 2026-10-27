import {
  SpaceDocumentSession,
  isSpaceListItem,
  type SpaceSessionOptions,
  type SpaceSessionSnapshot,
} from "@t2code/client-runtime/spaces";
import type {
  SpaceCursor,
  SpacePageGetResult,
  SpacePageTarget,
  SpaceReadBlocksInput,
  SpaceReadBlocksResult,
} from "@t2code/contracts/spaces";
import type { SpaceEditorWindow } from "./document";
import type { SpaceCompensation } from "@t2code/client-runtime/spaces";

export interface SpaceDocumentPorts {
  readonly getPage: () => Promise<SpacePageGetResult>;
  readonly readBlocks: (input: SpaceReadBlocksInput) => Promise<SpaceReadBlocksResult>;
  readonly windowLimit: () => number;
}
interface DocumentSnapshot {
  readonly session: SpaceSessionSnapshot;
  readonly metadata: SpacePageGetResult | null;
  readonly nextCursor: SpaceCursor | null;
  readonly loading: boolean;
  readonly error: unknown;
  readonly completeWindow: boolean;
}

export class SpaceDocumentController {
  readonly session: SpaceDocumentSession;
  readonly #ports: SpaceDocumentPorts;
  readonly #listeners = new Set<() => void>();
  #snapshot: DocumentSnapshot;
  #request = 0;
  #opening: Promise<void> | null = null;

  constructor(key: SpacePageTarget, options: SpaceSessionOptions, ports: SpaceDocumentPorts) {
    this.session = new SpaceDocumentSession(key, options);
    this.#ports = ports;
    this.#snapshot = {
      session: this.session.getSnapshot(),
      metadata: null,
      nextCursor: null,
      loading: false,
      error: null,
      completeWindow: false,
    };
  }
  getSnapshot = (): DocumentSnapshot => {
    const session = this.session.getSnapshot();
    if (this.#snapshot.session !== session) this.#snapshot = { ...this.#snapshot, session };
    return this.#snapshot;
  };
  editorWindow(): SpaceEditorWindow {
    const { session, metadata, completeWindow } = this.getSnapshot();
    const complete = completeWindow && session.baseRevision === metadata?.page.revision;
    return {
      revision: session.baseRevision ?? 0,
      blocks: session.blocks,
      completeParents: complete
        ? [null, ...session.blocks.filter(isSpaceListItem).map((block) => block.id)]
        : [],
    };
  }
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    const unsubscribe = this.session.subscribe(listener);
    return () => {
      unsubscribe();
      this.#listeners.delete(listener);
    };
  };
  canRelease() {
    const state = this.session.getSnapshot();
    return (
      this.#listeners.size === 0 &&
      (this.session.canRelease() ||
        (!state.hydrated && state.persistenceError === null && this.#snapshot.error === null))
    );
  }
  #update(patch: Partial<DocumentSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  invalidate() {
    this.#request++;
    this.#opening = null;
    this.#update({ nextCursor: null, loading: false });
  }
  #assertClean() {
    const state = this.session.getSnapshot();
    if (
      state.dirty ||
      state.pending ||
      state.status === "saving" ||
      state.persistenceError !== null
    )
      throw new Error("Resolve the draft before replacing its loaded window");
  }
  open(): Promise<void> {
    if (this.#opening) return this.#opening;
    if (
      this.session.getSnapshot().hydrated &&
      this.#snapshot.metadata &&
      (this.session.getSnapshot().dirty || this.session.getSnapshot().pending)
    )
      return Promise.resolve();
    const opening = this.#load().finally(() => {
      if (this.#opening === opening) this.#opening = null;
    });
    this.#opening = opening;
    return opening;
  }
  refresh(): Promise<void> {
    if (this.#opening) return this.#opening;
    this.#assertClean();
    return this.#load();
  }
  next(): Promise<void> {
    this.#assertClean();
    if (!this.#snapshot.nextCursor) return Promise.resolve();
    return this.#load(this.#snapshot.nextCursor);
  }
  async #read(cursor?: SpaceCursor) {
    const metadata = await this.#ports.getPage();
    const blocks = await this.#ports.readBlocks({
      ...this.session.key,
      revision: metadata.page.revision,
      limit: Math.min(100, this.#ports.windowLimit()),
      ...(cursor ? { cursor } : {}),
    });
    if (blocks.revision !== metadata.page.revision)
      throw new Error("Spaces window revision changed");
    return { metadata, blocks };
  }
  async #load(cursor?: SpaceCursor) {
    const request = ++this.#request;
    this.#update({ loading: true, error: null });
    try {
      const { metadata, blocks } = await this.#read(cursor);
      if (request !== this.#request) return;
      if (this.session.getSnapshot().hydrated) {
        this.#assertClean();
      } else await this.session.hydrate(blocks);
      if (request !== this.#request) return;
      const state = this.session.getSnapshot();
      if (!state.dirty && !state.pending && state.persistenceError === null)
        this.session.replaceWindow(blocks);
      const loaded = this.session.getSnapshot();
      this.#update({
        metadata,
        completeWindow:
          cursor === undefined &&
          blocks.nextCursor === null &&
          loaded.baseRevision === blocks.revision &&
          loaded.memberIds.length === blocks.blocks.length &&
          loaded.memberIds.every((id) => blocks.blocks.some((block) => block.id === id)),
        nextCursor: state.dirty || state.pending ? null : blocks.nextCursor,
      });
    } catch (error) {
      if (request === this.#request) this.#update({ error });
      throw error;
    } finally {
      if (request === this.#request) this.#update({ loading: false });
    }
  }
  async save() {
    this.#update({ error: null, nextCursor: null });
    try {
      await this.session.save();
      const state = this.session.getSnapshot();
      if (!state.dirty && !state.pending && state.persistenceError === null) await this.#load();
    } catch (error) {
      this.#update({ error });
      throw error;
    }
  }
  async compensate(direction: SpaceCompensation) {
    this.session.prepareCompensation(direction);
    const generation = this.session.getSnapshot().generation;
    await this.save();
    return this.session.getSnapshot().acknowledgedGeneration === generation;
  }
  async discard() {
    if (this.session.getSnapshot().pending)
      throw new Error("Resolve the pending receipt before discarding");
    const request = ++this.#request;
    this.#update({ loading: true, error: null, nextCursor: null });
    try {
      const { metadata, blocks } = await this.#read();
      if (request !== this.#request) return;
      await this.session.discardDraft(blocks);
      if (request === this.#request)
        this.#update({
          metadata,
          nextCursor: blocks.nextCursor,
          completeWindow: blocks.nextCursor === null,
        });
    } catch (error) {
      if (request === this.#request) this.#update({ error });
      throw error;
    } finally {
      if (request === this.#request) this.#update({ loading: false });
    }
  }
}

export class SpaceDocumentControllers {
  readonly #documents = new Map<string, { controller: SpaceDocumentController; readers: number }>();
  constructor(readonly create: (key: SpacePageTarget) => SpaceDocumentController) {}
  open(key: SpacePageTarget) {
    const controller = this.acquire(key);
    let released = false;
    return {
      ready: controller
        .open()
        .catch(() => {})
        .then(() => controller),
      release: () => {
        if (released) return;
        released = true;
        this.release(key, controller);
      },
    };
  }
  acquire(key: SpacePageTarget) {
    const id = JSON.stringify([key.environmentId, key.pageId]);
    const existing = this.#documents.get(id);
    if (existing) {
      existing.readers++;
      return existing.controller;
    }
    for (const [unusedId, item] of this.#documents) {
      if (
        item.readers === 0 &&
        !item.controller.getSnapshot().loading &&
        item.controller.canRelease()
      )
        this.#documents.delete(unusedId);
    }
    if (this.#documents.size >= 8)
      throw new Error("Close or resolve an open Spaces document before opening another");
    const controller = this.create(key);
    this.#documents.set(id, { controller, readers: 1 });
    return controller;
  }
  release(key: SpacePageTarget, controller: SpaceDocumentController) {
    const id = JSON.stringify([key.environmentId, key.pageId]);
    const item = this.#documents.get(id);
    if (!item || item.controller !== controller) return;
    item.readers = Math.max(0, item.readers - 1);
    if (item.readers > 0) return;
    controller.invalidate();
    if (controller.canRelease()) this.#documents.delete(id);
  }
}
