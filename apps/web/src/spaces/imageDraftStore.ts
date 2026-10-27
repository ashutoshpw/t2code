import {
  decodeSpaceImageRecord,
  type SpaceImageRecord,
  type SpaceImageStore,
} from "@t2code/client-runtime/spaces";
import { spaceDraftTransaction } from "./draftDatabase";

function records(values: unknown[]): SpaceImageRecord[] {
  if (values.length > 2)
    throw new Error("Image original storage exceeds two slots; retained data cannot be evicted");
  const decoded = values.map(decodeSpaceImageRecord);
  if (
    new Set(decoded.map((r) => r.slot)).size !== decoded.length ||
    new Set(decoded.map((r) => r.id)).size !== decoded.length
  )
    throw new Error("Image original storage has duplicate identities");
  return decoded;
}
export function createSpaceImageStore(): SpaceImageStore {
  async function mutate(record: SpaceImageRecord, expected: number | null, remove = false) {
    const value = decodeSpaceImageRecord(record);
    let failure: unknown;
    await spaceDraftTransaction("media", "readwrite", (store, transaction) => {
      const request = store.getAll(undefined, 3);
      request.addEventListener("success", () => {
        try {
          const all = records(request.result as unknown[]);
          const previous = all.find((r) => r.slot === value.slot);
          if (
            expected === null
              ? previous || all.some((r) => r.id === value.id)
              : !previous || previous.id !== value.id || previous.sequence !== expected
          )
            throw new Error("Image original changed in another view; reload its exact intent");
          if (remove) store.delete(value.slot);
          else store.put(value, value.slot);
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
      return records(
        await spaceDraftTransaction("media", "readonly", (store) => store.getAll(undefined, 3)),
      );
    },
    put: (record, expected) => mutate(record, expected),
    remove: (record) => mutate(record, record.sequence, true),
  };
}
