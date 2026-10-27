import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import type { SpacesPageReader } from "./reader";

// Dirty or unresolved owners survive view release; only clean unused owners may be evicted.
export class MobileSpaceDocuments {
  readonly #entries = new Map<string, { reader: SpacesPageReader; owners: number }>();
  constructor(readonly create: (target: SpacePageNavigationTarget) => SpacesPageReader) {}

  acquire(target: SpacePageNavigationTarget) {
    const key = JSON.stringify([target.environmentId, target.pageId]);
    let entry = this.#entries.get(key);
    if (!entry) {
      for (const [unusedKey, item] of this.#entries)
        if (item.owners === 0 && item.reader.canRelease()) this.#entries.delete(unusedKey);
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
