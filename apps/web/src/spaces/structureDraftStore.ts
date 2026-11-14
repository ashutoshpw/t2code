import {
  decodeSpaceStructureJournal,
  type SpaceStructureStore,
} from "@t2code/client-runtime/spaces";
import { spaceDraftTransaction } from "./draftDatabase";

export function createSpaceStructureStore(): SpaceStructureStore {
  return {
    async load(environmentId) {
      const value: unknown = await spaceDraftTransaction("structure", "readonly", (store) =>
        store.get(environmentId),
      );
      return value === undefined ? null : decodeSpaceStructureJournal(value, environmentId);
    },
    async write(environmentId, journal) {
      const value = decodeSpaceStructureJournal(journal, environmentId);
      await spaceDraftTransaction("structure", "readwrite", (store) =>
        store.put(value, environmentId),
      );
    },
  };
}
