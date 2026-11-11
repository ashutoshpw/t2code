import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";

import { boot, env, fixture } from "./Spaces.testkit.ts";
import { databaseKit, exec, pid, raw } from "./Databases.testkit.ts";

const NOTE = pid("note01");
const HEAVY = pid("heavy1");
const ROWS = 90;
// About 1,500 evaluation steps per row: a batch fits far fewer rows than the 200-row cap.
const EXPENSIVE = 'replaceAll(repeat("abc def ", 500), "[a-z]+", "x")';

const setup = Effect.fn("DatabaseComputedDrainTest.setup")(function* (dbPath: string) {
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
});
