import type {
  SpaceCapability,
  SpaceCursor,
  SpacePageGetResult,
  SpaceReadBlocksInput,
  SpaceReadBlocksResult,
} from "@t2code/contracts/spaces";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import { canBrowseSpaces, type SpacesAvailability } from "@t2code/client-runtime/state/spaces";

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
  writable: "Mobile page viewing is read-only. Editing is available on desktop.",
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
}

export class SpacesPageReader {
  readonly #listeners = new Set<() => void>();
  #request = 0;
  #abort: AbortController | null = null;
  #snapshot: ReaderSnapshot = { loading: false, error: null, location: null, window: null };

  constructor(
    readonly target: SpacePageNavigationTarget,
    readonly ports: {
      access: SpacesReadAccess;
      locate: (signal: AbortSignal) => Promise<LocatedPage>;
      blocks: (input: SpaceReadBlocksInput, signal: AbortSignal) => Promise<SpaceReadBlocksResult>;
    },
  ) {}

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #publish(snapshot: ReaderSnapshot) {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
  invalidate() {
    this.#request++;
    this.#abort?.abort();
    this.#publish({ loading: false, error: null, location: null, window: null });
  }
  first = () => this.#load();
  next = () => {
    if (this.#snapshot.loading || !this.#snapshot.window?.nextCursor) return Promise.resolve();
    return this.#load(this.#snapshot.window.nextCursor);
  };

  async #load(cursor?: SpaceCursor): Promise<void> {
    const request = ++this.#request;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    const { access } = this.ports;
    const current = () => request === this.#request && access.current();
    this.#publish({ loading: true, error: null, location: null, window: null });
    try {
      if (!canBrowseSpaces(access.availability) || !access.capability || !current())
        throw new Error(spacesAvailabilityMessage[access.availability]);
      const location = await this.ports.locate(abort.signal);
      if (!current()) return;
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
        abort.signal,
      );
      if (!current()) return;
      if (!location.current()) throw new Error("The page location changed. Refresh to resolve it.");
      if (
        window.revision !== location.page.revision ||
        window.blocks.length > limit ||
        new Set(window.blocks.map((block) => block.id)).size !== window.blocks.length ||
        new TextEncoder().encode(JSON.stringify(window)).byteLength >
          Math.min(2 * 1024 * 1024, access.capability.limits.maxBlockWindowResponseBytes)
      )
        throw new Error("The page window changed or exceeds its read limit. Refresh to try again.");
      this.#publish({ loading: false, error: null, location, window });
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
      });
    }
  }
}
