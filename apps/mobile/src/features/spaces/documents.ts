import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import type { SpacesPageReader } from "./reader";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageId } from "@t2code/contracts/spaces";

// Dirty or unresolved owners survive view release; only clean unused owners may be evicted.
export class MobileSpaceDocuments {
  readonly #entries = new Map<string, { reader: SpacesPageReader; owners: number }>();
  readonly #reservations = new Set<string>();
  constructor(readonly create: (target: SpacePageNavigationTarget) => SpacesPageReader) {}

  assertUnreserved(target: { environmentId: EnvironmentId; pageId: SpacePageId }) {
    if (this.#reservations.has(JSON.stringify([target.environmentId, target.pageId])))
      throw new Error("This page is reserved; recover its exact structural operation first");
  }

  reserve(environmentId: EnvironmentId, pages: readonly SpacePageId[], restoring = false) {
    if (pages.length > 8 || new Set(pages).size !== pages.length)
      throw new Error("A structural operation is limited to eight affected pages");
    const ids = pages.map((pageId) => JSON.stringify([environmentId, pageId]));
    if (ids.some((id) => this.#reservations.has(id)))
      throw new Error("An affected page is already reserved");
    const releases: (() => void)[] = [];
    try {
      for (const id of ids) {
        this.#reservations.add(id);
        const entry = this.#entries.get(id);
        if (entry) releases.push(entry.reader.reserveStructure(restoring));
      }
    } catch (error) {
      for (const release of releases) release();
      for (const id of ids) this.#reservations.delete(id);
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases) release();
      for (const id of ids) this.#reservations.delete(id);
    };
  }

  async refreshStructure(environmentId: EnvironmentId, pages: readonly SpacePageId[]) {
    if (pages.length > 8 || new Set(pages).size !== pages.length)
      throw new Error("A structural refresh is limited to eight affected pages");
    const errors: unknown[] = [];
    for (const pageId of pages) {
      const entry = this.#entries.get(JSON.stringify([environmentId, pageId]));
      if (!entry) continue;
      try {
        await entry.reader.refreshStructure();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Some affected pages could not refresh; refresh them before editing",
      );
  }

  acquire(target: SpacePageNavigationTarget) {
    this.assertUnreserved(target);
    const key = JSON.stringify([target.environmentId, target.pageId]);
    let entry = this.#entries.get(key);
    if (!entry) {
      for (const [unusedKey, item] of this.#entries)
        if (!this.#reservations.has(unusedKey) && item.owners === 0 && item.reader.canRelease())
          this.#entries.delete(unusedKey);
      if (this.#entries.size >= 8)
        throw new Error("Close or resolve an open Spaces page before opening another.");
      entry = { reader: this.create(target), owners: 0 };
      this.#entries.set(key, entry);
    }
    const owned = entry;
    owned.owners++;
    let released = false;
    return {
      reader: owned.reader,
      release: () => {
        if (released) return;
        released = true;
        if (this.#entries.get(key) !== owned) return;
        owned.owners--;
        if (owned.owners > 0) return;
        owned.reader.invalidate();
        if (owned.reader.canRelease()) this.#entries.delete(key);
      },
    };
  }
}
