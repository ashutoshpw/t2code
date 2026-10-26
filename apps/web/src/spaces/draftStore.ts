import { decodeSpaceDocumentDraft } from "@t2code/client-runtime/spaces";
import type { SpaceDraftStore } from "@t2code/client-runtime/spaces";

const databaseName = "t2code-space-document-drafts";
const storeName = "pages";

export function createSpaceDraftStore(): SpaceDraftStore {
  let connection: Promise<IDBDatabase> | null = null;
  function open(): Promise<IDBDatabase> {
    connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is unavailable; Spaces drafts cannot be persisted"));
        return;
      }
      let failed = false;
      const request = indexedDB.open(databaseName, 1);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(storeName))
          request.result.createObjectStore(storeName);
      });
      request.addEventListener("blocked", () => {
        failed = true;
        reject(new Error("Spaces draft storage upgrade is blocked by another tab"));
      });
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("Could not open Spaces drafts")),
      );
      request.addEventListener("success", () => {
        const database = request.result;
        if (failed) {
          database.close();
          return;
        }
        database.addEventListener("versionchange", () => {
          connection = null;
          database.close();
        });
        database.addEventListener("close", () => {
          connection = null;
        });
        resolve(database);
      });
    }).catch((error: unknown) => {
      connection = null;
      throw error;
    });
    return connection;
  }
  async function transaction<A>(
    mode: IDBTransactionMode,
    use: (store: IDBObjectStore) => IDBRequest<A>,
  ): Promise<A> {
    const database = await open();
    return new Promise<A>((resolve, reject) => {
      try {
        const tx = database.transaction(storeName, mode);
        let value: A;
        tx.addEventListener("abort", () =>
          reject(tx.error ?? new Error("Spaces draft transaction aborted")),
        );
        tx.addEventListener("error", () =>
          reject(tx.error ?? new Error("Spaces draft transaction failed")),
        );
        tx.addEventListener("complete", () => resolve(value));
        const request = use(tx.objectStore(storeName));
        request.addEventListener("success", () => {
          value = request.result;
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "InvalidStateError") {
          connection = null;
          database.close();
        }
        reject(error);
      }
    });
  }
  return {
    async load(key) {
      const value: unknown = await transaction("readonly", (store) =>
        store.get([key.environmentId, key.pageId]),
      );
      return value === undefined ? null : decodeSpaceDocumentDraft(value, key);
    },
    async write(key, draft) {
      const id = [key.environmentId, key.pageId];
      if (draft !== null) {
        const value = decodeSpaceDocumentDraft(draft, key);
        await transaction("readwrite", (store) => store.put(value, id));
      } else await transaction("readwrite", (store) => store.delete(id));
    },
  };
}
