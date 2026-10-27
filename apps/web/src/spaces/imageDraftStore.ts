import {
  decodeSpaceImageRecord,
  decodeSpaceMediaRecords,
  type SpaceImageRecord,
  type SpaceImageStore,
} from "@t2code/client-runtime/spaces";
import { spaceDraftTransaction } from "./draftDatabase";

export function createSpaceImageStore(): SpaceImageStore {
  async function mutate(record: SpaceImageRecord, expected: number | null, remove = false) {
    const value = decodeSpaceImageRecord(record);
    let failure: unknown;
    await spaceDraftTransaction("media", "readwrite", (store, transaction) => {
      const request = store.getAll(undefined, 3);
      request.addEventListener("success", () => {
        try {
          const all = decodeSpaceMediaRecords(request.result as unknown[]);
          const previous = all.find((r) => r.slot === value.slot);
          if (
            expected === null
              ? previous || all.some((r) => r.id === value.id)
              : !previous || previous.id !== value.id || previous.sequence !== expected
          )
            throw new Error("Image original changed in another view; reload its exact intent");
          if (remove) store.delete(value.slot);
          else {
            decodeSpaceMediaRecords([...all.filter((r) => r.slot !== value.slot), value]);
            store.put(value, value.slot);
          }
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      });
      return request;
    }).catch((error: unknown) => {
      throw failure ?? error;
    });
  }
  return {
    async load() {
      return decodeSpaceMediaRecords(
        await spaceDraftTransaction("media", "readonly", (store) => store.getAll(undefined, 3)),
      );
    },
    put: (record, expected) => mutate(record, expected),
    remove: (record) => mutate(record, record.sequence, true),
  };
}
