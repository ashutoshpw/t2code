import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { exec, pid, raw } from "./Databases.testkit.ts";
import { bulkRows, cond, ids, seed } from "./DatabaseQuery.testkit.ts";
import { fixture } from "./Spaces.testkit.ts";

const ROWS = 10_000;
const BUDGET = pid("budget1");
const F1 = pid("scale01");
const F2 = pid("scale02");
const R = pid("scale03");

it.layer(NodeServices.layer)("Spaces computed values at 10,000 rows", (it) => {
  it.effect("recomputes only dependents and answers filtered, sorted windows from the cells", () =>
    fixture(
      (dbPath) =>
        Effect.gen(function* () {
          const { service, kit, dataSourceId, spaceId, projects, project, query } =
            yield* seed(dbPath);
          yield* bulkRows({ dbPath, dataSourceId, spaceId, count: ROWS, prefix: "bulk" });
          yield* exec(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS})
                INSERT INTO spaces_db_cells (page_id, property_id, ord, data_source_id, ref)
                SELECT 'bulk-' || i, ${ids.project}, 0, ${dataSourceId},
                  CASE i % 2 WHEN 0 THEN ${project[0]!} ELSE ${project[1]!} END FROM n`;
            }),
          );
          yield* kit.schema(projects, [
            { op: "addProperty", property: { id: BUDGET, name: "Budget", type: "number" } },
          ]);
          yield* kit.setCells(projects, project[0]!, { [BUDGET]: 100 });
          yield* kit.setCells(projects, project[1]!, { [BUDGET]: 200 });
          yield* kit.schema(dataSourceId, [
            {
              op: "addProperty",
              property: {
                id: F1,
                name: "Twice",
                type: "formula",
                config: { expression: 'prop("Points") * 2' },
              },
            },
            {
              op: "addProperty",
              property: {
                id: F2,
                name: "Total",
                type: "formula",
                config: { expression: 'prop("Points") + prop("Project").first().prop("Budget")' },
              },
            },
            {
              op: "addProperty",
              property: {
                id: R,
                name: "Biggest",
                type: "rollup",
                config: {
                  relationPropertyId: ids.project,
                  targetPropertyId: BUDGET,
                  function: "max",
                },
              },
            },
          ]);
          // The definitions queued every row; the mutation computed a bounded share of them.
          assert.isTrue((yield* query({ limit: 1 })).computedPending);
          const queuedAfterSchema = yield* raw(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{
                readonly n: number;
              }>`SELECT COUNT(*) AS n FROM spaces_db_computed_dirty`;
            }),
          );
          assert.isAtLeast(queuedAfterSchema[0]!.n, ROWS + 7 - 200 - 7);
          yield* service.drainComputed;
          assert.isUndefined((yield* query({ limit: 1 })).computedPending);

          // A filtered, sorted query on a computed property: windows match the arithmetic.
          const points = (i: number) => (i * 7919) % 1000;
          const total = (i: number) => points(i) + (i % 2 === 0 ? 100 : 200);
          const expected = Array.from({ length: ROWS }, (_, k) => total(k + 1))
            .filter((value) => value > 600)
            .sort((a, b) => a - b);
          const window = (cursor?: C.SpaceCursor) =>
            query({
              filter: cond(F2, "greater_than", 600),
              sorts: [{ property: F2, direction: "ascending" }],
              properties: [F2],
              include: { total: true },
              limit: 25,
              ...(cursor === undefined ? {} : { cursor }),
            });
          const first = yield* window();
          const second = yield* window(first.nextCursor!);
          const values = (result: C.SpaceDatabaseQueryResult) =>
            result.rows.map((row) => (row.cells[F2] as { value: number }).value);
          assert.equal(first.total, expected.length);
          assert.deepEqual(values(first), expected.slice(0, 25));
          assert.deepEqual(values(second), expected.slice(25, 50));
          const biggest = yield* query({ limit: 1, properties: [R, F1] });
          const firstId = Number(biggest.rows[0]!.page.id.replace("bulk-", ""));
          assert.deepEqual(biggest.rows[0]!.cells[R], {
            type: "number",
            value: firstId % 2 === 0 ? 100 : 200,
          });

          // Count what an edit queues: a trigger records every row entering the queue.
          yield* exec(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`CREATE TABLE enqueued (page_id TEXT)`;
              yield* sql`CREATE TRIGGER enqueued_dirty AFTER INSERT ON spaces_db_computed_dirty
                BEGIN INSERT INTO enqueued VALUES (new.page_id); END`;
            }),
          );
          const enqueued = () =>
            raw(
              dbPath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const rows = yield* sql<{ readonly page_id: string }>`SELECT page_id FROM enqueued`;
                return rows.map((row) => row.page_id);
              }),
            );
          yield* kit.setCells(dataSourceId, C.SpacePageId.make("bulk-5"), { [ids.points]: 1 });
          assert.deepEqual(yield* enqueued(), ["bulk-5"]);
          const edited = yield* query({ filter: cond(F1, "equals", 2), limit: 5 });
          assert.includeMembers(
            edited.rows.map((row) => row.page.id),
            ["bulk-5"],
          );
          // A change to a related project queues exactly the rows that point at it.
          yield* exec(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`DELETE FROM enqueued`;
            }),
          );
          yield* kit.setCells(projects, project[0]!, { [BUDGET]: 150 });
          // Every bulk row with an even number, plus the two seeded rows (Alpha, bravo) that point at it.
          assert.equal((yield* enqueued()).length, ROWS / 2 + 2);
          assert.isTrue((yield* query({ limit: 1 })).computedPending);
          yield* service.drainComputed;
          const even = yield* kit.row(C.SpacePageId.make("bulk-10"), [F2]);
          assert.deepEqual(even.row.cells[F2], { type: "number", value: points(10) + 150 });
          const odd = yield* kit.row(C.SpacePageId.make("bulk-11"), [F2]);
          assert.deepEqual(odd.row.cells[F2], { type: "number", value: points(11) + 200 });

          // The referrer lookup is an index search on the ref index, never a scan of the cells.
          const plan = yield* raw(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
                SELECT c.page_id, c.data_source_id FROM spaces_db_cells c
                JOIN spaces_pages p ON p.page_id = c.page_id AND p.row_template = 0 AND p.trash_batch_id IS NULL
                WHERE c.ref = ${project[0]!} AND c.data_source_id = ${dataSourceId} AND c.property_id = ${ids.project}`;
            }),
          );
          assert.isTrue(
            plan.some(
              (row) =>
                row.detail.includes("USING INDEX spaces_db_cells_ref") ||
                row.detail.includes("USING COVERING INDEX spaces_db_cells_ref"),
            ),
          );
          assert.isFalse(plan.some((row) => /^SCAN c\b/.test(row.detail)));
        }),
      true,
      { backgroundDrain: false },
    ),
  );
});
