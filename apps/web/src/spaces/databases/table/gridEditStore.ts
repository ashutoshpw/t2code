import { useSyncExternalStore } from "react";

export interface EditSession {
  readonly pageId: string;
  readonly propertyId: string;
  /** The character that started the edit. */
  readonly seed: string | undefined;
}

export const cellKey = (pageId: string, propertyId: string) => `${pageId}\u0000${propertyId}`;

/**
 * Which cell is being edited, and the cell focus is waiting for. Subscriptions are per cell, so
 * starting or ending an edit re-renders the two cells involved and nothing else.
 */
export class GridEditStore {
  #session: EditSession | null = null;
  #wanted: string | null = null;
  readonly #listeners = new Map<string, Set<() => void>>();
  #parked = false;
  #lastCell: { pageId: string; propertyId: string } | null = null;
  /** The scroll container, set by the grid root. */
  root: HTMLElement | null = null;
  #adding: string | null = null;

  /** The next focus of the grid root comes from leaving the grid and must not be redirected to a cell. */
  park(): void {
    this.#parked = true;
  }

  /** True once after `park`. */
  takeParked(): boolean {
    const parked = this.#parked;
    this.#parked = false;
    return parked;
  }

  rememberCell(cell: { pageId: string; propertyId: string }): void {
    this.#lastCell = cell;
  }

  lastCell(): { pageId: string; propertyId: string } | null {
    return this.#lastCell;
  }

  attach = (element: HTMLElement | null) => {
    this.root = element;
  };

  /** The group id (or "") a row is being added to. */
  setAdding(id: string | null): void {
    const before = this.#adding;
    this.#adding = id;
    if (before !== null) this.#notify(`add:${before}`);
    if (id !== null) this.#notify(`add:${id}`);
  }

  isAdding = (id: string) => this.#adding === id;

  subscribe = (key: string, listener: () => void) => {
    let set = this.#listeners.get(key);
    if (set === undefined) this.#listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(key);
    };
  };

  #notify(key: string) {
    for (const listener of this.#listeners.get(key) ?? []) listener();
  }

  /** The session when `key` is the cell being edited, else null; the identity holds until the next edit. */
  sessionFor = (key: string): EditSession | null =>
    this.#session !== null && cellKey(this.#session.pageId, this.#session.propertyId) === key
      ? this.#session
      : null;

  current(): EditSession | null {
    return this.#session;
  }

  start(pageId: string, propertyId: string, seed?: string): void {
    const existing = this.#session;
    if (existing?.pageId === pageId && existing.propertyId === propertyId) return;
    this.#session = { pageId, propertyId, seed };
    if (existing !== null) this.#notify(cellKey(existing.pageId, existing.propertyId));
    this.#notify(cellKey(pageId, propertyId));
  }

  stop(): void {
    const existing = this.#session;
    if (existing === null) return;
    this.#session = null;
    this.#notify(cellKey(existing.pageId, existing.propertyId));
  }

  want(pageId: string, propertyId: string): void {
    this.#wanted = cellKey(pageId, propertyId);
  }

  /** True once for the cell focus was waiting for. */
  takeWanted(pageId: string, propertyId: string): boolean {
    if (this.#wanted !== cellKey(pageId, propertyId)) return false;
    this.#wanted = null;
    return true;
  }
}

export function useCellSession(store: GridEditStore, key: string): EditSession | null {
  return useSyncExternalStore(
    (listener) => store.subscribe(key, listener),
    () => store.sessionFor(key),
  );
}

export function useAdding(store: GridEditStore, id: string): boolean {
  return useSyncExternalStore(
    (listener) => store.subscribe(`add:${id}`, listener),
    () => store.isAdding(id),
  );
}
