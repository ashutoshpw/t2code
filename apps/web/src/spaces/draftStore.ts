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
