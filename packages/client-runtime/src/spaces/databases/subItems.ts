import type {
  SpaceCellValue,
  SpaceDatabaseQueryInput,
  SpaceDatabaseRow,
  SpacePageId,
  SpaceRelatedPage,
} from "@t2code/contracts/spaces";
import type { PendingCellEdit } from "./cellEdits.ts";
import { DatabaseQuerySession, type QuerySessionPorts } from "./querySession.ts";

/** What one expanded parent shows: its children under the view's own filter and sorts. */
interface SubItemChildren {
  readonly rows: ReadonlyArray<SpaceDatabaseRow>;
  readonly status: "loading" | "ready" | "error";
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
}

interface SubItemSnapshot {
  readonly children: ReadonlyMap<string, SubItemChildren>;
}

const EMPTY: SubItemSnapshot = { children: new Map() };

/**
 * One query session per expanded parent row, all sharing the top-level query's filter and sorts.
 * Framework-free: a UI hands it a base input and reads snapshots.
 */
export class SubItemTree {
  readonly #ports: QuerySessionPorts;
  readonly #sessions = new Map<string, { session: DatabaseQuerySession; stop: () => void }>();
  readonly #listeners = new Set<() => void>();
  #base: SpaceDatabaseQueryInput | null = null;
  #snapshot: SubItemSnapshot = EMPTY;
  #disposed = false;

  readonly #maxExpanded: number;

  /** Past `maxExpanded` open parents, expanding one more collapses the least recently expanded. */
  constructor(ports: QuerySessionPorts, options?: { readonly maxExpanded?: number }) {
    this.#ports = ports;
    this.#maxExpanded = options?.maxExpanded ?? Number.POSITIVE_INFINITY;
  }

  /** The top-level rows query (no scope). A new input re-points every expanded parent. */
  setBase(input: SpaceDatabaseQueryInput | null): void {
    if (this.#disposed) return;
    if (input === null) this.#base = null;
    else {
      const { scope: _scope, ...rest } = input;
      this.#base = { ...rest, mode: "rows" };
    }
    for (const [id, entry] of this.#sessions) entry.session.setInput(this.#childInput(id));
    this.#publish();
  }

  expand(parentId: SpacePageId): void {
    if (this.#disposed || this.#sessions.has(parentId)) return;
    // A Map iterates in insertion order, so the first key is the oldest expansion.
    while (this.#sessions.size >= this.#maxExpanded) {
      const oldest = this.#sessions.keys().next();
      if (oldest.done === true) break;
      this.collapse(oldest.value as SpacePageId);
    }
    const session = new DatabaseQuerySession(this.#ports);
    const stop = session.subscribe(() => this.#publish());
    this.#sessions.set(parentId, { session, stop });
    session.setInput(this.#childInput(parentId));
    this.#publish();
  }

  collapse(parentId: SpacePageId): void {
    const entry = this.#sessions.get(parentId);
    if (entry === undefined) return;
    entry.stop();
    entry.session.dispose();
    this.#sessions.delete(parentId);
    this.#publish();
  }

  loadMore(parentId: SpacePageId): void {
    this.#sessions.get(parentId)?.session.loadMore();
  }

  /** Our own acknowledged write reaches every expanded parent. */
  noteAck(ack: {
    dataRevision: number;
    affects: boolean;
    structural: boolean;
    edits?: ReadonlyArray<PendingCellEdit>;
  }): void {
    for (const { session } of this.#sessions.values()) session.noteAck(ack);
  }

  noteRelatedPages(pages: Readonly<Record<string, SpaceRelatedPage>>): void {
    for (const { session } of this.#sessions.values()) session.noteRelatedPages(pages);
  }

  /** Another client's or an agent's write: ask every expanded parent again. */
  invalidate(): void {
    for (const { session } of this.#sessions.values()) session.invalidate();
  }

  isExpanded(parentId: string): boolean {
    return this.#sessions.has(parentId);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): SubItemSnapshot => this.#snapshot;

  /** Drops every expanded parent but keeps the tree usable, for effect cleanups that re-run. */
  reset(): void {
    this.#closeSessions();
    this.#publish();
  }

  dispose(): void {
    this.#disposed = true;
    this.#closeSessions();
    this.#listeners.clear();
  }

  #closeSessions() {
    for (const entry of this.#sessions.values()) {
      entry.stop();
      entry.session.dispose();
    }
    this.#sessions.clear();
  }

  #childInput(parentId: string): SpaceDatabaseQueryInput | null {
    if (this.#base === null) return null;
    const { scope: _scope, ...rest } = this.#base;
    return { ...rest, scope: { parentRowId: parentId as SpacePageId } };
  }

  #publish() {
    const previous = this.#snapshot.children;
    const next = new Map<string, SubItemChildren>();
    let changed = previous.size !== this.#sessions.size;
    for (const [id, { session }] of this.#sessions) {
      const state = session.getSnapshot();
      const known = previous.get(id);
      const rows = state.windows?.rows ?? known?.rows ?? [];
      const status = state.status === "idle" ? "loading" : state.status;
      const hasMore = state.windows?.nextCursor != null;
      const same =
        known !== undefined &&
        known.rows === rows &&
        known.status === status &&
        known.hasMore === hasMore &&
        known.loadingMore === state.loadingMore &&
        known.relatedPages === state.relatedPages;
      if (!same) changed = true;
      next.set(
        id,
        same
          ? known
          : {
              rows,
              status,
              hasMore,
              loadingMore: state.loadingMore,
              relatedPages: state.relatedPages,
            },
      );
    }
    if (!changed) return;
    this.#snapshot = { children: next };
    for (const listener of this.#listeners) listener();
  }
}

/** The cells a new sub-item starts with: the parent link only. */
export function subItemCells(
  parentPropertyId: string,
  parentId: SpacePageId,
): Record<string, SpaceCellValue> {
  return { [parentPropertyId]: [parentId] };
}
