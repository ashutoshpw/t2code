import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeSqlite from "node:sqlite";
import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceBlockId,
  SpacePageId,
  SpaceReceiptEpoch,
  SpaceMutationId,
} from "@t2code/contracts/spaces";
import {
  spaceDraftMaxBytes,
  type SpaceDocumentDraft,
  type SpaceStructureJournal,
} from "@t2code/client-runtime/spaces";

import { diskDatabase, openDatabaseAsync } from "./mobile-database.test-support";

import * as MobileDatabase from "./mobile-database";

describe("mobile database legacy cache migration", () => {
  it("maps legacy thread records to their SQLite identity", () => {
    const payload = JSON.stringify({
      schemaVersion: 2,
      environmentId: "environment-1",
      threadId: "thread-1",
      snapshot: {},
    });

    expect(MobileDatabase.decodeLegacyCacheRecord("connection-thread-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "thread",
      cacheKey: "thread-1",
      schemaVersion: 2,
      payload,
    });
  });

  it("skips malformed legacy records", () => {
    expect(MobileDatabase.decodeLegacyCacheRecord("connection-vcs-refs", "{not-json")).toBeNull();
    expect(
      MobileDatabase.decodeLegacyCacheRecord(
        "connection-vcs-refs",
        JSON.stringify({ schemaVersion: 1, environmentId: "environment-1" }),
      ),
    ).toBeNull();
  });
});

describe("offline pull request cache", () => {
  const environmentId = "cached-environment" as import("@t2code/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@t2code/contracts").EnvironmentId;

  async function sqliteDatabase() {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA user_version = 1");
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        await run(database);
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(sqliteDatabase);
        const database = yield* MobileDatabase.make;
        yield* database.saveCache(environmentId, "pull-request", "v1:list", 1, '{"entries":[]}');
        yield* database.saveCache(otherEnvironment, "pull-request", "v1:list", 1, "other");
        expect(yield* database.loadCache(environmentId, "pull-request", "v1:list")).toEqual(
          Option.some('{"entries":[]}'),
        );
        yield* database.clearEnvironmentCache(environmentId);
        expect((yield* database.loadCache(environmentId, "pull-request", "v1:list"))._tag).toBe(
          "None",
        );
        expect((yield* database.loadCache(otherEnvironment, "pull-request", "v1:list"))._tag).toBe(
          "Some",
        );
      }),
    ),
  );
});

const draftPage = {
  environmentId: EnvironmentId.make("draft-environment"),
  pageId: SpacePageId.make("page"),
};
function pageDraft(key = draftPage, text = "Retained"): SpaceDocumentDraft {
  const block = {
    id: SpaceBlockId.make("block"),
    parentId: null,
    order: "a",
    type: "paragraph",
    version: 1,
    content: { runs: [{ text, marks: [{ type: "bold", version: 1 }] }] },
  };
  return {
    version: 1,
    key,
    baseRevision: 4,
    generation: 2,
    memberIds: [block.id],
    blocks: [block],
    mutations: [{ kind: "replace", block }],
    pending: {
      key,
      mutationId: "exact-pending-id",
      receiptEpoch: SpaceReceiptEpoch.make("original-epoch"),
      baseRevision: 4,
      generation: 1,
      mutations: [{ kind: "replace", block }],
    },
  };
}

describe("durable mobile Spaces page drafts", () => {
  it.effect(
    "migrates an existing database, reopens exact pending drafts and leaves them outside all cache clearing",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* diskDatabase();
          const seed = new NodeSqlite.DatabaseSync(fixture.file);
          seed.exec(
            'CREATE TABLE client_preferences (singleton INTEGER PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO client_preferences VALUES (1, \'{"theme":"dark"}\', 1)',
          );
          seed.close();
          const first = yield* fixture.open();
          const otherKey = {
            ...draftPage,
            environmentId: EnvironmentId.make("another-environment"),
          };
          yield* Effect.promise(async () => {
            expect(await first.store.load(draftPage)).toBeNull();
            await first.store.write(draftPage, pageDraft());
            await first.store.write(otherKey, pageDraft(otherKey, "Different environment"));
          });
          yield* first.database.saveCache(draftPage.environmentId, "thread", "page", 1, "clear me");
          yield* first.database.clearCacheKind(draftPage.environmentId, "thread");
          yield* first.database.clearEnvironmentCache(draftPage.environmentId);
          yield* first.database.clearAllCaches;
          expect(yield* first.database.loadPreferencesJson).toEqual(
            Option.some({ payload: '{"theme":"dark"}', updatedAt: 1 }),
          );
          yield* first.close;
          const reopened = yield* fixture.open();
          yield* Effect.promise(async () => {
            expect(await reopened.store.load(draftPage)).toEqual(pageDraft());
            expect(await reopened.store.load(otherKey)).toEqual(
              pageDraft(otherKey, "Different environment"),
            );
          });
          const inspect = new NodeSqlite.DatabaseSync(fixture.file);
          expect(inspect.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
          inspect.close();
        }),
      ),
  );

  it.effect(
    "does not report durability before COMMIT and rolls back a failed commit without losing the previous record",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* diskDatabase();
          const { store } = yield* fixture.open();
          yield* Effect.promise(async () => {
            const original = pageDraft();
            await store.write(draftPage, original);
            const reached = Promise.withResolvers<void>();
            const commit = Promise.withResolvers<void>();
            fixture.control.beforeCommit = async () => {
              reached.resolve();
              await commit.promise;
            };
            let completed = false;
            const replacement = pageDraft(draftPage, "Committed replacement");
            const writing = store.write(draftPage, replacement).then(() => {
              completed = true;
            });
            await reached.promise;
            expect(completed).toBe(false);
            expect(await store.load(draftPage)).toEqual(original);
            commit.resolve();
            await writing;
            expect(await store.load(draftPage)).toEqual(replacement);
            fixture.control.beforeCommit = async () => {
              throw new Error("Commit refused");
            };
            await expect(
              store.write(draftPage, pageDraft(draftPage, "Never committed")),
            ).rejects.toBeDefined();
            fixture.control.beforeCommit = null;
            expect(await store.load(draftPage)).toEqual(replacement);
          });
        }),
      ),
  );

  it.effect.each(["json", "future", "size", "identity"] as const)(
    "retains a %s-invalid stored record and refuses implicit replacement or deletion",
    (invalid) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* diskDatabase();
          const { store } = yield* fixture.open();
          yield* Effect.promise(async () => {
            const sqlite = new NodeSqlite.DatabaseSync(fixture.file);
            const valid = pageDraft();
            const payload =
              invalid === "json"
                ? "{broken"
                : invalid === "size"
                  ? "x".repeat(spaceDraftMaxBytes + 1)
                  : JSON.stringify(
                      invalid === "future"
                        ? { ...valid, version: 2 }
                        : { ...valid, key: { ...draftPage, environmentId: "wrong" } },
                    );
            sqlite.exec("PRAGMA ignore_check_constraints = ON");
            sqlite
              .prepare("INSERT INTO spaces_page_drafts VALUES (?, ?, 1, ?, ?, 0)")
              .run(draftPage.environmentId, draftPage.pageId, payload, Buffer.byteLength(payload));
            sqlite.close();
            await expect(store.load(draftPage)).rejects.toBeDefined();
            await expect(store.write(draftPage, null)).rejects.toBeDefined();
            await expect(store.write(draftPage, valid)).rejects.toBeDefined();
            const inspect = new NodeSqlite.DatabaseSync(fixture.file);
            expect(inspect.prepare("SELECT payload FROM spaces_page_drafts").get()).toEqual({
              payload,
            });
            inspect.close();
          });
        }),
      ),
  );

  it.effect(
    "admits exact record and total byte bounds, refusing overflow without evicting a retained draft",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* diskDatabase();
          const { store } = yield* fixture.open();
          yield* Effect.promise(async () => {
            function maximal(key: typeof draftPage) {
              const block = {
                id: SpaceBlockId.make("opaque"),
                type: "future",
                version: 2,
                parentId: null,
                order: "a",
                content: { padding: "" },
              };
              const draft: SpaceDocumentDraft = {
                version: 1,
                key,
                baseRevision: 1,
                generation: 0,
                memberIds: [block.id],
                blocks: [block],
                mutations: [],
                pending: null,
              };
              block.content.padding = "x".repeat(
                spaceDraftMaxBytes - Buffer.byteLength(JSON.stringify(draft)),
              );
              return draft;
            }
            const keys = Array.from({ length: 8 }, (_, index) => ({
              ...draftPage,
              pageId: SpacePageId.make(`p${index}`),
            }));
            for (const key of keys) await store.write(key, maximal(key));
            const first = maximal(keys[0]!);
            await expect(
              store.write(keys[0]!, {
                ...first,
                blocks: [
                  { ...first.blocks[0]!, content: { padding: "x".repeat(spaceDraftMaxBytes) } },
                ],
              }),
            ).rejects.toBeDefined();
            const overflow = { ...draftPage, pageId: SpacePageId.make("overflow") };
            await expect(store.write(overflow, pageDraft(overflow))).rejects.toBeDefined();
            expect(await store.load(overflow)).toBeNull();
            expect(await store.load(keys[0]!)).toEqual(first);
          });
        }),
      ),
  );

  it.effect("bounds retained row admission without evicting another page", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* diskDatabase();
        const { store } = yield* fixture.open();
        yield* Effect.promise(async () => {
          for (let index = 0; index < 128; index++) {
            const key = { ...draftPage, pageId: SpacePageId.make(`small-${index}`) };
            await store.write(key, pageDraft(key));
          }
          await expect(store.write(draftPage, pageDraft())).rejects.toBeDefined();
          const retained = { ...draftPage, pageId: SpacePageId.make("small-0") };
          expect(await store.load(retained)).toEqual(pageDraft(retained));
        });
      }),
    ),
  );
});

function structureJournal(
  environmentId = draftPage.environmentId,
  title = "Retained library title",
): SpaceStructureJournal {
  return {
    version: 1,
    environmentId,
    history: null,
    pending: {
      request: {
        operation: "createSpace",
        input: {
          environmentId,
          mutationId: SpaceMutationId.make("exact-structure-intent"),
          receiptEpoch: SpaceReceiptEpoch.make("original-structure-epoch"),
          title,
        },
      },
      library: { version: 2, knownIds: [] },
      inverse: null,
      observed: { pages: [], roots: [] },
      direction: "move",
      conflict: false,
    },
  };
}

describe("durable mobile structural journals", () => {
  it.effect(
    "upgrades v2, retains exact intent across cache clearing and reopen, and rolls back a failed replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* diskDatabase();
          const seed = new NodeSqlite.DatabaseSync(fixture.file);
          seed.exec("PRAGMA user_version = 2");
          seed.close();
          const first = yield* fixture.open();
          const original = structureJournal();
          yield* Effect.promise(async () => {
            expect(await first.structure.load(draftPage.environmentId)).toBeNull();
            await first.store.write(draftPage, pageDraft());
            await first.structure.write(draftPage.environmentId, original);
          });
          yield* first.database.saveCache(
            draftPage.environmentId,
            "thread",
            "cached",
            1,
            "clear me",
          );
          yield* first.database.clearCacheKind(draftPage.environmentId, "thread");
          yield* first.database.clearEnvironmentCache(draftPage.environmentId);
          yield* first.database.clearAllCaches;
          yield* first.close;
          const reopened = yield* fixture.open();
          yield* Effect.promise(async () => {
            expect(await reopened.structure.load(draftPage.environmentId)).toEqual(original);
            expect(await reopened.store.load(draftPage)).toEqual(pageDraft());
            fixture.control.beforeCommit = async () => {
              throw new Error("Journal commit refused");
            };
            await expect(
              reopened.structure.write(
                draftPage.environmentId,
                structureJournal(draftPage.environmentId, "Must roll back"),
              ),
            ).rejects.toBeDefined();
            fixture.control.beforeCommit = null;
            expect(await reopened.structure.load(draftPage.environmentId)).toEqual(original);
          });
          const inspect = new NodeSqlite.DatabaseSync(fixture.file);
          expect(inspect.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
          inspect.close();
        }),
      ),
  );

  it.effect.each(["json", "future", "identity", "oversize"] as const)(
    "retains a %s-corrupt structural row and refuses implicit replacement",
    (invalid) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* diskDatabase();
          const { structure } = yield* fixture.open();
          const journal = structureJournal();
          const payload =
            invalid === "json"
              ? "{broken"
              : invalid === "oversize"
                ? JSON.stringify(
                    structureJournal(draftPage.environmentId, "x".repeat(2 * 1024 * 1024)),
                  )
                : JSON.stringify(
                    invalid === "future"
                      ? { ...journal, version: 2 }
                      : { ...journal, environmentId: "wrong" },
                  );
          const seed = new NodeSqlite.DatabaseSync(fixture.file);
          seed.exec("PRAGMA ignore_check_constraints = ON");
          seed
            .prepare("INSERT INTO spaces_structure_journals VALUES (?, 1, ?, ?, 0)")
            .run(draftPage.environmentId, payload, Buffer.byteLength(payload));
          seed.close();
          yield* Effect.promise(async () => {
            await expect(structure.load(draftPage.environmentId)).rejects.toBeDefined();
            await expect(structure.write(draftPage.environmentId, journal)).rejects.toBeDefined();
          });
          const inspect = new NodeSqlite.DatabaseSync(fixture.file);
          expect(inspect.prepare("SELECT payload FROM spaces_structure_journals").get()).toEqual({
            payload,
          });
          inspect.close();
        }),
      ),
  );

  it.effect("bounds environment journal admission without evicting a pending operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* diskDatabase();
        const { structure } = yield* fixture.open();
        yield* Effect.promise(async () => {
          for (let index = 0; index < 8; index++) {
            const environmentId = EnvironmentId.make(`journal-environment-${index}`);
            await structure.write(environmentId, structureJournal(environmentId));
          }
          await expect(
            structure.write(draftPage.environmentId, structureJournal()),
          ).rejects.toBeDefined();
          const firstId = EnvironmentId.make("journal-environment-0");
          expect(await structure.load(firstId)).toEqual(structureJournal(firstId));
          expect(await structure.load(draftPage.environmentId)).toBeNull();
        });
      }),
    ),
  );
});
