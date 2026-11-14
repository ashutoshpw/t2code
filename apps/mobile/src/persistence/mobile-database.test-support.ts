import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";

import {
  createMobileSpaceDraftStore,
  createMobileSpaceStructureStore,
} from "../features/spaces/draftStore";
import { MobileDatabase, make } from "./mobile-database";

const native = vi.hoisted(() => ({ openDatabaseAsync: vi.fn() }));
vi.mock("expo-sqlite", () => native);
export const openDatabaseAsync = native.openDatabaseAsync;

export const diskDatabase = Effect.fn("MobileDatabaseTest.diskDatabase")(function* () {
  openDatabaseAsync.mockReset();
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t2-mobile-drafts-"))),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  );
  const file = NodePath.join(directory, "client.sqlite");
  const initial = new NodeSqlite.DatabaseSync(file);
  initial.exec("PRAGMA user_version = 1");
  initial.close();
  const control: { beforeCommit: (() => Promise<void>) | null } = { beforeCommit: null };
  function statements(sqlite: NodeSqlite.DatabaseSync) {
    return {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number | null>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number | null>) =>
        sqlite.prepare(sql).get(...args) ?? null,
      getAllAsync: async (sql: string, ...args: Array<string | number | null>) =>
        sqlite.prepare(sql).all(...args),
    };
  }
  openDatabaseAsync.mockImplementation(async () => {
    const main = new NodeSqlite.DatabaseSync(file);
    return {
      ...statements(main),
      closeAsync: async () => {
        main.close();
      },
      withExclusiveTransactionAsync: async (
        run: (transaction: ReturnType<typeof statements>) => Promise<void>,
      ) => {
        const transaction = new NodeSqlite.DatabaseSync(file);
        try {
          transaction.exec("BEGIN");
          await run(statements(transaction));
          await control.beforeCommit?.();
          transaction.exec("COMMIT");
        } catch (error) {
          if (transaction.isTransaction) transaction.exec("ROLLBACK");
          throw error;
        } finally {
          transaction.close();
        }
      },
    };
  });
  const open = Effect.fn("MobileDatabaseTest.open")(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const database = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
    const context = Context.add(yield* Effect.context<never>(), MobileDatabase, database);
    return {
      database,
      store: createMobileSpaceDraftStore(async () => context),
      structure: createMobileSpaceStructureStore(async () => context),
      close: Scope.close(scope, Exit.void),
    };
  });
  return { file, control, open };
});
