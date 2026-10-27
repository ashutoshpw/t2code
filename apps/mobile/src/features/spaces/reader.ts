import type {
  SpaceCapability,
  SpaceCursor,
  SpacePageGetResult,
  SpaceReadBlocksInput,
  SpaceReadBlocksResult,
} from "@t2code/contracts/spaces";
import type {
  SpaceDocumentSession,
  SpaceSessionSnapshot,
  SpacePageNavigationTarget,
} from "@t2code/client-runtime/spaces";
import { canBrowseSpaces, type SpacesAvailability } from "@t2code/client-runtime/state/spaces";

import { MobileSpaceEditing } from "./editing";

export interface SpacesReadAccess {
  readonly availability: SpacesAvailability;
  readonly capability: SpaceCapability | undefined;
  readonly current: () => boolean;
}

export const spacesAvailabilityMessage: Record<SpacesAvailability, string> = {
  disconnected: "Connect this environment to browse Spaces.",
  unavailable: "Spaces is off or unavailable in this environment. Open its settings to enable it.",
  "unsupported-version": "Update this app to browse this environment’s Spaces version.",
  denied: "This connection does not have permission to read Spaces.",
  "read-only": "Pages are read-only on this connection.",
  writable: "Browse pages in this environment.",
};

interface LocatedPage extends SpacePageGetResult {
  readonly ancestors: readonly SpacePageGetResult["page"][];
  readonly current: () => SpacePageGetResult | null;
  readonly resolvedBlockId?: SpacePageNavigationTarget["blockId"];
}

interface ReaderSnapshot {
  readonly loading: boolean;
  readonly error: string | null;
  readonly location: LocatedPage | null;
  readonly window: SpaceReadBlocksResult | null;
  readonly session: SpaceSessionSnapshot;
}

export class SpacesPageReader {
  readonly #listeners = new Set<() => void>();
  #request = 0;
  #abort: AbortController | null = null;
  #opening: Promise<void> | null = null;
  #hydration: Promise<void> | null = null;
  #access: SpacesReadAccess | null = null;
  #stopSession: (() => void) | null = null;
  #serverWindow: SpaceReadBlocksResult | null = null;
  #snapshot: ReaderSnapshot;
  readonly editing: MobileSpaceEditing;

  constructor(
    readonly target: SpacePageNavigationTarget,
    readonly ports: {
      session: SpaceDocumentSession;
      access: SpacesReadAccess;
      locate: (signal: AbortSignal) => Promise<LocatedPage>;
      blocks: (input: SpaceReadBlocksInput, signal: AbortSignal) => Promise<SpaceReadBlocksResult>;
    },
  ) {
    this.#snapshot = {
      loading: false,
      error: null,
      location: null,
      window: null,
      session: ports.session.getSnapshot(),
    };
    this.editing = new MobileSpaceEditing({
      session: ports.session,
      access: () => this.ports.access,
      readWindow: () => this.readCurrentWindow(),
    });
  }

  get session() {
    return this.ports.session;
  }

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    if (this.#listeners.size === 0)
      this.#stopSession = this.session.subscribe(() => this.#publishSession());
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stopSession?.();
        this.#stopSession = null;
      }
    };
  };
  canRelease() {
    const state = this.session.getSnapshot();
    return (
      this.#listeners.size === 0 &&
      this.editing.getSnapshot().focus === null &&
      this.editing.getSnapshot().busy === null &&
      !this.#opening &&
      !this.#hydration &&
      (this.session.canRelease() || (!state.hydrated && state.persistenceError === null))
    );
  }
  #publishSession() {
    const session = this.session.getSnapshot();
    const source = this.#serverWindow;
    this.#publish({
      ...this.#snapshot,
      session,
      window:
        source && session.hydrated
          ? {
              revision: session.baseRevision ?? source.revision,
              blocks: session.blocks,
              nextCursor:
                !session.dirty &&
                !session.pending &&
                session.persistenceError === null &&
                session.baseRevision === source.revision
                  ? source.nextCursor
                  : null,
            }
          : null,
    });
  }
  #publish(snapshot: ReaderSnapshot) {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
  invalidate() {
    this.#request++;
    this.#abort?.abort();
    this.#opening = null;
    this.#serverWindow = null;
    this.#publish({
      loading: false,
      error: null,
      location: null,
      window: null,
      session: this.session.getSnapshot(),
    });
  }
  first = () => this.#start();
  next = () => {
    if (this.#snapshot.loading || !this.#snapshot.window?.nextCursor) return Promise.resolve();
    const state = this.session.getSnapshot();
    if (
      this.editing.getSnapshot().focus ||
      state.dirty ||
      state.pending ||
      state.persistenceError !== null
    )
      return Promise.resolve();
    return this.#start(this.#snapshot.window.nextCursor);
  };

  async readCurrentWindow() {
    return (await this.#readWindow(this.ports.access, new AbortController().signal)).window;
  }

  async #readWindow(access: SpacesReadAccess, signal: AbortSignal, cursor?: SpaceCursor) {
    if (!canBrowseSpaces(access.availability) || !access.capability || !access.current())
      throw new Error(spacesAvailabilityMessage[access.availability]);
    const location = await this.ports.locate(signal);
    if (!access.current() || signal.aborted) throw new Error("The page connection changed");
    if (!location.current() || (!this.target.blockId && location.page.id !== this.target.pageId))
      throw new Error("The page location changed. Refresh to resolve it.");
    const limit = Math.min(100, access.capability.limits.maxBlockWindowBlocks);
    const window = await this.ports.blocks(
      {
        environmentId: this.target.environmentId,
        pageId: location.page.id,
        revision: location.page.revision,
        limit,
        ...(cursor ? { cursor } : {}),
      },
      signal,
    );
    if (!location.current()) throw new Error("The page location changed. Refresh to resolve it.");
    if (
      window.revision !== location.page.revision ||
      window.blocks.length > limit ||
      new Set(window.blocks.map((block) => block.id)).size !== window.blocks.length ||
      new TextEncoder().encode(JSON.stringify(window)).byteLength >
        Math.min(2 * 1024 * 1024, access.capability.limits.maxBlockWindowResponseBytes)
    )
      throw new Error("The page window changed or exceeds its read limit. Refresh to try again.");
    if (!access.current() || signal.aborted) throw new Error("The page connection changed");
    return { location, window };
  }

  #start(cursor?: SpaceCursor) {
    if (this.#opening && this.#access?.current()) return this.#opening;
    const opening = this.#load(cursor).finally(() => {
      if (this.#opening === opening) this.#opening = null;
    });
    this.#opening = opening;
    return opening;
  }

  async #load(cursor?: SpaceCursor): Promise<void> {
    const request = ++this.#request;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    const { access } = this.ports;
    this.#access = access;
    const current = () => request === this.#request && access.current();
    this.#serverWindow = null;
    this.#publish({
      loading: true,
      error: null,
      location: null,
      window: null,
      session: this.session.getSnapshot(),
    });
    try {
      const { location, window } = await this.#readWindow(access, abort.signal, cursor);
      if (!current()) return;
      if (!this.session.getSnapshot().hydrated) {
        const hydration = this.session.hydrate(window);
        this.#hydration = hydration;
        try {
          await hydration;
        } finally {
          if (this.#hydration === hydration) this.#hydration = null;
        }
      }
      if (!current() || !location.current()) return;
      const state = this.session.getSnapshot();
      if (
        !this.editing.getSnapshot().focus &&
        !state.dirty &&
        !state.pending &&
        state.persistenceError === null
      )
        this.session.replaceWindow(window);
      this.#serverWindow = window;
      this.#snapshot = { ...this.#snapshot, loading: false, error: null, location };
      this.#publishSession();
    } catch (error) {
      if (!current()) return;
      this.#publish({
        loading: false,
        error:
          cursor &&
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "SpaceCursorStaleError"
            ? "The page changed. Open the first window to continue."
            : error instanceof Error
              ? error.message
              : "Could not load this page.",
        location: null,
        window: null,
        session: this.session.getSnapshot(),
      });
    }
  }
}
