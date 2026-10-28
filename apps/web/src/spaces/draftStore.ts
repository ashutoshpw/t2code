import { decodeSpaceDocumentDraft } from "@t2code/client-runtime/spaces";
import type { SpaceDraftStore } from "@t2code/client-runtime/spaces";

import { spaceDraftTransaction } from "./draftDatabase";

export function createSpaceDraftStore(): SpaceDraftStore {
  return {
    async load(key) {
      const value: unknown = await spaceDraftTransaction("pages", "readonly", (store) =>
        store.get([key.environmentId, key.pageId]),
      );
      return value === undefined ? null : decodeSpaceDocumentDraft(value, key);
    },
    async write(key, draft) {
      const id = [key.environmentId, key.pageId];
      if (draft !== null) {
        const value = decodeSpaceDocumentDraft(draft, key);
        await spaceDraftTransaction("pages", "readwrite", (store) => store.put(value, id));
      } else await spaceDraftTransaction("pages", "readwrite", (store) => store.delete(id));
    },
  };
}

export const AUTOSAVE_IDLE_MS = 1000;

export interface AutosaveTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const browserTimers: AutosaveTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createAutosave(options: {
  save: () => Promise<unknown>;
  idleMs?: number;
  timers?: AutosaveTimers;
}) {
  const timers = options.timers ?? browserTimers;
  const idleMs = options.idleMs ?? AUTOSAVE_IDLE_MS;
  let handle: unknown = null;
  let scheduled: unknown = null;
  let attempted: unknown = null;
  const cancel = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
    scheduled = null;
  };
  const fire = () => {
    attempted = scheduled;
    cancel();
    void options.save().catch(() => {});
  };
  return {
    /** Pass a key that changes with every edit while a save is wanted, or null when none is. */
    update(key: unknown) {
      if (key === null) return cancel();
      if (key === attempted || (handle !== null && key === scheduled)) return;
      cancel();
      scheduled = key;
      handle = timers.set(fire, idleMs);
    },
    flush() {
      if (handle === null) return;
      fire();
    },
    retry() {
      cancel();
      attempted = null;
      void options.save().catch(() => {});
    },
    dispose() {
      this.flush();
    },
  };
}
