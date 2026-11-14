import {
  SpaceValidationError,
  SpaceNotFoundError,
  type SpaceCursor,
  type SpacePageGetResult,
  type SpaceReadBlocksInput,
  type SpaceReadBlocksResult,
} from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";
import type {
  SpaceDocumentSession,
  SpaceSessionSnapshot,
  SpacePageNavigationTarget,
} from "@t2code/client-runtime/spaces";
import { canBrowseSpaces, type SpacesAvailability } from "@t2code/client-runtime/state/spaces";

import { MobileSpaceEditing } from "./editing";

const isSpaceValidationError = Schema.is(SpaceValidationError);
const isSpaceNotFoundError = Schema.is(SpaceNotFoundError);

import type { SpacesReadAccess } from "./readAccess";
export type { SpacesReadAccess } from "./readAccess";

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
  readonly unavailable: "trashed" | "deleted" | null;
  readonly structureBlocked: boolean;
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
  #reserved = false;
  #firstWindow = false;
  #snapshot: ReaderSnapshot;
  readonly editing: MobileSpaceEditing;

  constructor(
    readonly target: SpacePageNavigationTarget,
    readonly ports: {
      session: SpaceDocumentSession;
      access: SpacesReadAccess;
      locate: (signal: AbortSignal) => Promise<LocatedPage>;
      blocks: (input: SpaceReadBlocksInput, signal: AbortSignal) => Promise<SpaceReadBlocksResult>;
      beforeRead?: () => Promise<void>;
      mediaBlocked?: () => boolean;
      confirmDeleted?: (signal: AbortSignal) => Promise<boolean>;
    },
  ) {
    this.#snapshot = {
      unavailable: null,
      structureBlocked: false,
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
      assertMutable: () => this.assertContentReady(),
      completeWindow: () => this.completeImageWindow(),
    });
  }

  get session() {
    return this.ports.session;
  }

  refreshAccess() {
    this.#publishSession();
  }

  completeImageWindow() {
    const state = this.session.getSnapshot();
    return (
      this.#firstWindow &&
      this.#serverWindow?.nextCursor === null &&
      state.hydrated &&
      !this.#snapshot.loading &&
      this.#snapshot.error === null &&
      this.#snapshot.unavailable === null &&
      this.#snapshot.location?.current() != null &&
      state.baseRevision === this.#serverWindow.revision &&
      JSON.stringify(state.memberIds) ===
        JSON.stringify(this.#serverWindow.blocks.map((block) => block.id))
    );
  }

  assertContentReady() {
    if (this.ports.mediaBlocked?.())
      throw new Error("Finish the retained image insertion before editing or changing windows");
    if (this.#snapshot.unavailable === "deleted")
      throw new Error("This page was permanently deleted; retained content is read-only");
    if (this.#snapshot.unavailable === "trashed")
      throw new Error("This page is in Trash. Restore it before editing");
    if (this.#reserved)
      throw new Error("This page is reserved; recover its structural operation first");
    if (this.#snapshot.loading || this.#snapshot.error !== null)
      throw new Error("Refresh this page successfully before editing");
  }

  #structureAvailability() {
    const state = this.session.getSnapshot();
    // A pristine unread Trash view still gets the coordinator's durable draft check before any send.
    const unreadTrash =
      this.#snapshot.unavailable === "trashed" &&
      !state.hydrated &&
      state.status === "loading" &&
      !state.dirty &&
      !state.pending &&
      state.persistenceError === null &&
      this.#hydration === null;
    return unreadTrash ? null : this.session.structureAvailability();
  }

  reserveStructure(restoring: boolean) {
    if (this.#reserved) throw new Error("This page already has a structural reservation");
    if (
      !restoring &&
      (this.#snapshot.loading ||
        this.#snapshot.error !== null ||
        this.editing.getSnapshot().focus ||
        this.editing.getSnapshot().busy ||
        this.#structureAvailability())
    )
      throw new Error(
        "Finish loading or resolve the affected page draft before changing structure",
      );
    this.#reserved = true;
    this.#publish({ ...this.#snapshot, structureBlocked: true });
    return () => {
      this.#reserved = false;
      this.#publish({ ...this.#snapshot, structureBlocked: false });
    };
  }

  async refreshStructure() {
    try {
      if (
        this.editing.getSnapshot().focus ||
        this.editing.getSnapshot().busy ||
        this.#structureAvailability()
      )
        throw new Error("Resolve the affected page draft before refreshing structure");
      await this.#load(undefined, true);
    } catch (error) {
      this.#publish({
        ...this.#snapshot,
        loading: false,
        error: error instanceof Error ? error.message : "Could not refresh this page",
      });
      throw error;
    }
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
      !this.#reserved &&
      !this.ports.mediaBlocked?.() &&
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
    this.#snapshot = {
      ...snapshot,
      structureBlocked: this.#reserved || this.ports.mediaBlocked?.() === true,
    };
    for (const listener of this.#listeners) listener();
  }
  invalidate() {
    this.#request++;
    this.#abort?.abort();
    this.#opening = null;
    this.#serverWindow = null;
    this.#firstWindow = false;
    this.#publish({
      unavailable: this.#snapshot.unavailable,
      structureBlocked: this.#reserved,
      loading: false,
      error: null,
      location: null,
      window: null,
      session: this.session.getSnapshot(),
    });
  }
  first = () => {
    if (
      this.ports.mediaBlocked?.() &&
      this.#snapshot.location?.current() &&
      this.#access?.current()
    )
      return Promise.resolve();
    return this.#start();
  };
  next = () => {
    if (this.#snapshot.loading || !this.#snapshot.window?.nextCursor) return Promise.resolve();
    const state = this.session.getSnapshot();
    if (
      this.editing.getSnapshot().focus ||
      this.ports.mediaBlocked?.() ||
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

  async #load(cursor?: SpaceCursor, structure = false): Promise<void> {
    const request = ++this.#request;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    const { access } = this.ports;
    this.#access = access;
    const current = () => request === this.#request && access.current();
    this.#serverWindow = null;
    this.#publish({
      unavailable: this.#snapshot.unavailable,
      structureBlocked: this.#reserved,
      loading: true,
      error: null,
      location: null,
      window: null,
      session: this.session.getSnapshot(),
    });
    try {
      if (this.ports.beforeRead) await this.ports.beforeRead();
      if (!structure && (this.#reserved || (cursor && this.ports.mediaBlocked?.())))
        throw new Error("Recover the reserved structural operation first");
      const { location, window } = await this.#readWindow(access, abort.signal, cursor);
      if (!current()) {
        if (structure) throw new Error("The page changed while refreshing structure");
        return;
      }
      if (!this.session.getSnapshot().hydrated) {
        const hydration = this.session.hydrate(window);
        this.#hydration = hydration;
        try {
          await hydration;
        } finally {
          if (this.#hydration === hydration) this.#hydration = null;
        }
      }
      if (!current() || !location.current()) {
        if (structure) throw new Error("The page location changed while refreshing structure");
        return;
      }
      const state = this.session.getSnapshot();
      if (
        !this.editing.getSnapshot().focus &&
        !this.ports.mediaBlocked?.() &&
        !state.dirty &&
        !state.pending &&
        state.persistenceError === null
      )
        this.session.replaceWindow(window);
      this.#serverWindow = window;
      this.#firstWindow = cursor === undefined;
      this.#snapshot = {
        ...this.#snapshot,
        unavailable: null,
        loading: false,
        error: null,
        location,
      };
      this.#publishSession();
    } catch (error) {
      if (!current()) {
        if (structure)
          throw new Error("The page connection changed while refreshing structure", {
            cause: error,
          });
        return;
      }
      let failure = error;
      let unavailable: "trashed" | "deleted" | null =
        isSpaceValidationError(error) && error.reason === "trashed" ? "trashed" : null;
      if (
        isSpaceNotFoundError(error) &&
        error.entity === "page" &&
        error.id === this.target.pageId &&
        this.ports.confirmDeleted
      ) {
        try {
          if (await this.ports.confirmDeleted(abort.signal)) unavailable = "deleted";
        } catch (cause) {
          failure = cause;
        }
        if (!current()) {
          if (structure)
            throw new Error("The page connection changed while confirming deletion", {
              cause: error,
            });
          return;
        }
      }
      if (unavailable !== null) {
        this.#publish({
          ...this.#snapshot,
          unavailable,
          loading: false,
          error: null,
          location: null,
          window: null,
          session: this.session.getSnapshot(),
        });
        return;
      }
      this.#publish({
        unavailable: this.#snapshot.unavailable,
        structureBlocked: this.#reserved,
        loading: false,
        error:
          cursor &&
          typeof failure === "object" &&
          failure !== null &&
          "_tag" in failure &&
          failure._tag === "SpaceCursorStaleError"
            ? "The page changed. Open the first window to continue."
            : failure instanceof Error
              ? failure.message
              : "Could not load this page.",
        location: null,
        window: null,
        session: this.session.getSnapshot(),
      });
      if (structure) throw failure;
    }
  }
}
