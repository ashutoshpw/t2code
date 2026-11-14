import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import { boot, env, fixture } from "./Spaces.testkit.ts";
import { databaseKit, exec, pid, raw } from "./Databases.testkit.ts";

const NOTE = pid("note01");
const HEAVY = pid("heavy1");
const ROWS = 90;
// About 1,500 evaluation steps per row: a batch fits far fewer rows than the 200-row cap.
const EXPENSIVE = 'replaceAll(repeat("abc def ", 500), "[a-z]+", "x")';

const seedRows = Effect.fn("DatabaseComputedDrainTest.seedRows")(function* () {
  const { service, common, page } = yield* boot();
  const kit = databaseKit(service, common, page.spaceId);
  const created = yield* kit.create("Heavy", {
    appendToPageId: page.id,
    properties: [{ id: NOTE, name: "Note", type: "text" }],
  });
  const source = created.dataSourceId;
  const rows = (yield* kit.addRows(
    source,
    Array.from({ length: ROWS }, (_, i) => ({ title: `row ${i}` })),
  )).rows.map((row) => row.pageId);
  return { service, kit, source, rows };
});

const setup = Effect.fn("DatabaseComputedDrainTest.setup")(function* (dbPath: string) {
  const { service, kit, source, rows } = yield* seedRows();
  // One log entry per row leaving the queue and one per user write, in commit order.
  yield* exec(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE drain_log (id INTEGER PRIMARY KEY, what TEXT)`;
      yield* sql`CREATE TRIGGER log_dequeue AFTER DELETE ON spaces_db_computed_dirty
        BEGIN INSERT INTO drain_log (what) VALUES ('row'); END`;
      yield* sql`CREATE TRIGGER log_user AFTER INSERT ON spaces_db_cells
        WHEN new.property_id = 'note01'
        BEGIN INSERT INTO drain_log (what) VALUES ('user'); END`;
    }),
  );
  yield* kit.schema(source, [
    {
      op: "addProperty",
      property: { id: HEAVY, name: "Heavy", type: "formula", config: { expression: EXPENSIVE } },
    },
  ]);
  return { service, kit, source, rows };
});

const pending = (dbPath: string) =>
  raw(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM spaces_db_computed_dirty`;
      return Number(row?.n ?? 0);
    }),
  );

const log = (dbPath: string) =>
  raw(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const found = yield* sql<{ readonly what: string }>`SELECT what FROM drain_log ORDER BY id`;
      return found.map((entry) => entry.what);
    }),
  );

it.layer(NodeServices.layer)("Spaces computed drain batches", (it) => {
  it.effect("bounds a mutation's own recompute and each background batch by evaluation work", () =>
    fixture(
      (dbPath) =>
        Effect.gen(function* () {
          const { service, kit, source, rows } = yield* setup(dbPath);
          // The schema write computed only what its budget allowed; the rest waits in the queue.
          const inMutation = (yield* log(dbPath)).length;
          assert.isAbove(inMutation, 0);
          assert.isBelow(inMutation, ROWS / 2);
          assert.isTrue(
            (yield* service.queryDatabase({
              ...env,
              dataSourceId: source,
              mode: "rows",
              timeZone: "UTC",
              limit: 1,
            })).computedPending,
          );

          // A user write issued while the drain runs waits for at most one bounded batch.
          const drain = yield* Effect.forkChild(service.drainComputed);
          yield* Effect.yieldNow;
          yield* kit.setCells(source, rows[0]!, { [NOTE]: [{ text: "edit", marks: [] }] });
          yield* Fiber.join(drain);
          const order = (yield* log(dbPath)).slice(inMutation);
          const userAt = order.indexOf("user");
          assert.isAtLeast(userAt, 0);
          assert.isBelow(userAt, ROWS / 2);
          // The backlog still converges.
          assert.isFalse(order.slice(userAt + 1).includes("user"));
          assert.equal(order.filter((entry) => entry === "row").length + inMutation, ROWS);
          const after = yield* service.queryDatabase({
            ...env,
            dataSourceId: source,
            mode: "rows",
            timeZone: "UTC",
            limit: 1,
          });
          assert.isUndefined(after.computedPending);
        }),
      true,
      { backgroundDrain: false },
    ),
  );

  it.effect.each(["defect", "interruption"] as const)(
    "starts a new background drain after one ends in %s",
    (ending) =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, kit, source, rows } = yield* seedRows();
          // Only the background drain reads the queue oldest first; a mutation reads it newest first.
          const isBackgroundBatch = (statement: Statement.Statement<unknown>) =>
            statement.compile()[0].includes("ORDER BY rowid ASC");
          const first = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const ends: Statement.Transformer = (statement) =>
            isBackgroundBatch(statement)
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(first, yield* Effect.fiber);
                  return yield* ending === "defect" ? Effect.die("batch failed") : Effect.interrupt;
                })
              : Effect.succeed(statement);
          // The schema write leaves a backlog and starts a background drain, which ends in `ending`.
          yield* kit
            .schema(source, [
              {
                op: "addProperty",
                property: {
                  id: HEAVY,
                  name: "Heavy",
                  type: "formula",
                  config: { expression: EXPENSIVE },
                },
              },
            ])
            .pipe(Effect.provideService(Statement.CurrentTransformer, ends));
          const ended = yield* Fiber.await(yield* Deferred.await(first));
          assert.isTrue(ending === "defect" ? Exit.hasDies(ended) : Exit.hasInterrupts(ended));
          const queued = yield* pending(dbPath);
          assert.isAbove(queued, 0);
          assert.isTrue(
            (yield* service.queryDatabase({
              ...env,
              dataSourceId: source,
              mode: "rows",
              timeZone: "UTC",
              limit: 1,
            })).computedPending,
          );

          // The next write starts a drain again, and that drain processes rows.
          const second = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
          const observes: Statement.Transformer = (statement) =>
            isBackgroundBatch(statement)
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(second, yield* Effect.fiber);
                  return statement;
                })
              : Effect.succeed(statement);
          yield* kit
            .setCells(source, rows[0]!, { [NOTE]: [{ text: "edit", marks: [] }] })
            .pipe(Effect.provideService(Statement.CurrentTransformer, observes));
          const resumed = yield* Fiber.await(yield* Deferred.await(second));
          assert.isTrue(Exit.isSuccess(resumed));
          assert.isBelow(yield* pending(dbPath), queued);
        }),
      ),
  );
});
