import type { EnvironmentId } from "@t2code/contracts";
import {
  SpacePageListResult,
  type SpaceCursor,
  type SpaceId,
  type SpacePageId,
  type SpacePageListInput,
} from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";
import * as Data from "effect/Data";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

const SPACE_NAVIGATION_LIMITS = {
  maxWindows: 16,
  maxBytes: 32 * 1024 * 1024,
  maxWindowBytes: 2 * 1024 * 1024,
  maxRows: 20,
} as const;

const encodeWindow = Schema.encodeSync(Schema.fromJsonString(SpacePageListResult));

type PageQuery = (target: {
  environmentId: EnvironmentId;
  input: SpacePageListInput;
}) => Atom.Atom<AsyncResult.AsyncResult<SpacePageListResult, unknown>>;
export interface SpaceNavigationWindow {
  readonly parentPageId: SpacePageId | null;
  readonly path: readonly SpacePageId[];
  readonly cursor: SpaceCursor | undefined;
  readonly data: SpacePageListResult | null;
  readonly pending: boolean;
  readonly error: string | null;
}
interface WindowEntry {
  view: SpaceNavigationWindow;
  bytes: number;
  rejected?: boolean;
  stop?: (() => void) | undefined;
}

/** @public Required to name the session in consuming packages' inferred types. */
export class SpacePageNavigation {
  readonly #options;
  readonly #listeners = new Set<() => void>();
  readonly #entries = new Map<SpacePageId | null, WindowEntry>();
  #revision: number | null = null;
  #snapshot: { windows: readonly SpaceNavigationWindow[]; error: string | null } = {
    windows: [],
    error: null,
  };

  constructor(options: {
    registry: AtomRegistry.AtomRegistry;
    pages: PageQuery;
    environmentId: EnvironmentId;
    spaceId: SpaceId;
    version: 1 | 2;
    maxRows: number;
  }) {
    this.#options = options;
  }

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    // SWR can return settled cached data before its deferred mount refresh runs.
    if (this.#listeners.size === 1) this.#load(null, [], undefined, true);
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#clear();
        this.#revision = null;
        this.#snapshot = { windows: [], error: null };
      }
    };
  };

  #publish(error: string | null = null) {
    this.#snapshot = { windows: [...this.#entries.values()].map((entry) => entry.view), error };
    for (const listener of this.#listeners) listener();
  }
  #remove(key: SpacePageId | null) {
    const entry = this.#entries.get(key);
    this.#entries.delete(key);
    entry?.stop?.();
  }
  #clear() {
    for (const key of this.#entries.keys()) this.#remove(key);
  }
  #descendants(path: readonly SpacePageId[]) {
    for (const [key, entry] of this.#entries) {
      if (
        entry.view.path.length > path.length &&
        path.every((id, index) => entry.view.path[index] === id)
      )
        this.#remove(key);
    }
  }

  expand(parentPageId: SpacePageId | null, pageId: SpacePageId) {
    const parent = this.#entries.get(parentPageId);
    if (this.#options.version !== 2 || !parent?.view.data?.items.some((page) => page.id === pageId))
      return;
    if (this.#entries.has(pageId)) {
      this.collapse(pageId);
      return;
    }
    if (parent.view.pending) return;
    const limits = SPACE_NAVIGATION_LIMITS;
    if (this.#entries.size >= limits.maxWindows || parent.view.path.includes(pageId)) {
      this.#publish("Collapse a branch before opening more child pages.");
      return;
    }
    this.#load(pageId, [...parent.view.path, pageId], undefined);
  }

  collapse(pageId: SpacePageId) {
    const entry = this.#entries.get(pageId);
    if (!entry) return;
    this.#descendants(entry.view.path);
    this.#remove(pageId);
    this.#publish();
  }

  next(parentPageId: SpacePageId | null) {
    const entry = this.#entries.get(parentPageId);
    if (!entry || entry.view.pending || !entry.view.data?.nextCursor) return;
    this.#load(parentPageId, entry.view.path, entry.view.data.nextCursor);
  }
  first(parentPageId: SpacePageId | null) {
    const entry = this.#entries.get(parentPageId);
    if (entry) this.#load(parentPageId, entry.view.path, undefined, true);
  }
  refresh = () => {
    this.#clear();
    this.#revision = null;
    this.#load(null, [], undefined, true);
  };

  #load(
    parentPageId: SpacePageId | null,
    path: readonly SpacePageId[],
    cursor: SpaceCursor | undefined,
    refresh = false,
  ) {
    this.#descendants(path);
    this.#remove(parentPageId);
    const entry: WindowEntry = {
      bytes: 0,
      view: { parentPageId, path, cursor, data: null, pending: true, error: null },
    };
    this.#entries.set(parentPageId, entry);
    const { registry, pages, environmentId, spaceId } = this.#options;
    const atom = pages({
      environmentId,
      input: {
        environmentId,
        spaceId,
        limit: Math.min(SPACE_NAVIGATION_LIMITS.maxRows, this.#options.maxRows),
        ...(parentPageId === null ? {} : { parentPageId }),
        ...(cursor ? { cursor } : {}),
      },
    });
    if (refresh) registry.refresh(atom);
    this.#publish();
    const stop = registry.subscribe(
      atom,
      (result) => {
        if (this.#entries.get(parentPageId) !== entry) return;
        if (result._tag === "Failure") {
          const failure = Cause.squash(result.cause);
          if (
            cursor &&
            typeof failure === "object" &&
            failure !== null &&
            "_tag" in failure &&
            failure._tag === "SpaceCursorStaleError"
          ) {
            const revision =
              "revision" in failure && typeof failure.revision === "number"
                ? failure.revision
                : this.#revision;
            this.#clear();
            this.#revision = revision;
            this.#load(null, [], undefined, true);
            return;
          }
          entry.bytes = 0;
          entry.view = {
            ...entry.view,
            data: null,
            pending: false,
            error: failure instanceof Error ? failure.message : "Could not load pages.",
          };
        } else {
          const data = Option.getOrNull(AsyncResult.value(result));
          if (data !== null) {
            if (this.#revision !== null && data.catalogRevision < this.#revision) {
              entry.view = {
                ...entry.view,
                data: null,
                pending: result.waiting,
                error: result.waiting
                  ? null
                  : "The library changed. Refresh to load its current location.",
              };
              entry.bytes = 0;
              this.#publish();
              return;
            }
            if (this.#revision !== null && data.catalogRevision > this.#revision) {
              this.#revision = data.catalogRevision;
              if (parentPageId !== null || cursor) {
                this.#clear();
                this.#load(null, [], undefined, true);
                return;
              }
              this.#descendants([]);
            }
            const bytes = new TextEncoder().encode(encodeWindow(data)).byteLength;
            const retained = [...this.#entries.values()].reduce(
              (sum, other) => sum + (other === entry ? 0 : other.bytes),
              0,
            );
            const limits = SPACE_NAVIGATION_LIMITS;
            const invalidSelector = data.items.some(
              (page) =>
                page.spaceId !== spaceId ||
                (this.#options.version === 1 &&
                  (page.rootOrder === null || page.location?.kind === "child")) ||
                (this.#options.version === 2 &&
                  (!page.location ||
                    page.location.spaceId !== spaceId ||
                    (parentPageId === null
                      ? page.location.kind !== "root"
                      : page.location.kind !== "child" ||
                        page.location.parentPageId !== parentPageId))),
            );
            if (
              bytes > limits.maxWindowBytes ||
              retained + bytes > limits.maxBytes ||
              data.items.length >
                Math.min(SPACE_NAVIGATION_LIMITS.maxRows, this.#options.maxRows) ||
              (invalidSelector && !result.waiting)
            ) {
              entry.bytes = 0;
              entry.rejected = true;
              this.#descendants(entry.view.path);
              entry.stop?.();
              entry.view = {
                ...entry.view,
                data: null,
                pending: false,
                error: invalidSelector
                  ? "Page locations changed. Refresh the library."
                  : "This page window exceeds the navigation limit.",
              };
            } else {
              entry.bytes = bytes;
              if (!result.waiting) this.#revision = data.catalogRevision;
              entry.view = {
                ...entry.view,
                data: invalidSelector ? null : data,
                pending: result.waiting,
                error: null,
              };
            }
          } else entry.view = { ...entry.view, pending: result.waiting };
        }
        this.#publish();
      },
      { immediate: true },
    );
    if (this.#entries.get(parentPageId) !== entry || entry.rejected) stop();
    else entry.stop = stop;
  }
}

class NavigationTarget extends Data.Class<{
  environmentId: EnvironmentId;
  spaceId: SpaceId;
  version: 1 | 2;
  maxRows: number;
}> {}

export function createSpacePageNavigationFactory(options: {
  registry: AtomRegistry.AtomRegistry;
  pages: PageQuery;
}) {
  const family = Atom.family(
    (input: { environmentId: EnvironmentId; spaceId: SpaceId; version: 1 | 2; maxRows: number }) =>
      new SpacePageNavigation({ ...options, ...input }),
  );
  return (input: {
    environmentId: EnvironmentId;
    spaceId: SpaceId;
    version: 1 | 2;
    maxRows: number;
  }) => family(new NavigationTarget(input));
}
