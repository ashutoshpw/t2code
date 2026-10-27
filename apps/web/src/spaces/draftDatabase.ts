const databaseName = "t2code-space-document-drafts";

function createDatabase() {
  let connection: Promise<IDBDatabase> | null = null;
  let currentDatabase: IDBDatabase | null = null;
  function open(): Promise<IDBDatabase> {
    if (connection) return connection;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is unavailable; Spaces drafts cannot be persisted"));
        return;
      }
      let failed = false;
      const request = indexedDB.open(databaseName, 2);
      request.addEventListener("upgradeneeded", () => {
        for (const name of ["pages", "structure"])
          if (!request.result.objectStoreNames.contains(name))
            request.result.createObjectStore(name);
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
        currentDatabase = database;
        database.addEventListener("versionchange", () => {
          if (currentDatabase === database) {
            connection = null;
            currentDatabase = null;
          }
          database.close();
        });
        database.addEventListener("close", () => {
          if (currentDatabase === database) {
            connection = null;
            currentDatabase = null;
          }
        });
        resolve(database);
      });
    }).catch((error: unknown) => {
      if (connection === opening) connection = null;
      throw error;
    });
    connection = opening;
    return opening;
  }
  async function transaction<A>(
    storeName: "pages" | "structure",
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
          if (currentDatabase === database) {
            connection = null;
            currentDatabase = null;
          }
          database.close();
        }
        reject(error);
      }
    });
  }
  return transaction;
}

export const spaceDraftTransaction = createDatabase();
