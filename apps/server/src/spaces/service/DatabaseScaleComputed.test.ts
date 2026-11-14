import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { computedDrainRows } from "../CorePolicy.ts";
import { databaseKit, exec, pid, raw } from "./Databases.testkit.ts";
import {
  SCALE_ROWS,
  SMALL_ROWS,
  type Scale,
  buildScale,
  observe,
  p,
  report,
} from "./DatabaseScale.testkit.ts";
import { boot, fixture } from "./Spaces.testkit.ts";

const BODIES = 0;
const DEQUEUED = "scale_dequeued";

/** Logs every row that leaves the computed queue, so tests can count rows recomputed. */
const logDequeues = (dbPath: string) =>
  exec(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`CREATE TABLE ${DEQUEUED} (page_id TEXT NOT NULL)`);
      yield* sql.unsafe(`CREATE TRIGGER ${DEQUEUED}_log AFTER DELETE ON spaces_db_computed_dirty
        BEGIN INSERT INTO ${DEQUEUED} VALUES (old.page_id); END`);
    }),
  );
const takeDequeued = (dbPath: string) =>
  exec(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly page_id: string }>`SELECT page_id FROM scale_dequeued`;
      yield* sql`DELETE FROM scale_dequeued`;
      return rows.map((row) => row.page_id);
    }),
  );
const queued = (dbPath: string) =>
  raw(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM spaces_db_computed_dirty`;
      return Number(row!.n);
    }),
  );

const NEXT = pid("frm009");

/** A formula over a stored number: adding it queues every row of the data source. */
const addBackfill = (s: Scale) =>
  s.kit.schema(s.dataSourceId, [
    {
      op: "addProperty",
      property: {
        id: NEXT,
        name: "Plus",
        type: "formula",
        config: { expression: 'prop("Num3") + 1' },
      },
    },
  ]);

it.layer(NodeServices.layer)("Spaces computed values at scale", (it) => {
  it.effect("recomputes exactly the rows that read an edit, and backfills in bounded batches", () =>
    fixture(
      (dbPath) =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const host = {
            service,
            common,
            spaceId: page.spaceId,
            appendToPageId: page.id,
            dbPath,
            kit: databaseKit(service, common, page.spaceId),
          };
          const large = yield* buildScale(host, {
            prefix: "big",
            rows: SCALE_ROWS,
            bodies: BODIES,
          });
          const small = yield* buildScale(host, {
            prefix: "small",
            rows: SMALL_ROWS,
            bodies: BODIES,
          });
          yield* logDequeues(dbPath);

          // A cell read by a formula on its own row: that row, no other.
          yield* large.kit.setCells(large.dataSourceId, large.taskId(5), { [p.n[0]!]: 7 });
          assert.deepEqual(yield* takeDequeued(dbPath), [large.taskId(5)]);
          const edited = yield* large.query({
            properties: [p.fNum],
            limit: 5,
            filter: { property: p.fNum, operator: "equals", value: 7 * 2 + ((5 * 31) % 97) },
          });
          assert.includeMembers(
            edited.rows.map((row) => row.page.id),
            [large.taskId(5)],
          );

          // A project number read by a rollup: the tasks that point at that project, never all.
          const referrers = yield* raw(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const rows = yield* sql<{
                readonly page_id: string;
              }>`SELECT page_id FROM spaces_db_cells
                WHERE data_source_id = ${large.dataSourceId} AND property_id = ${p.project}
                AND ref = ${large.projectId(1)}`;
              return rows.map((row) => C.SpacePageId.make(row.page_id)).sort();
            }),
          );
          yield* large.kit.setCells(large.projects, large.projectId(1), { [p.budget]: 999 });
          assert.deepEqual((yield* takeDequeued(dbPath)).sort(), referrers);
          report("rows recomputed for a project edit", {
            referrers: referrers.length,
            of: SCALE_ROWS,
          });
          assert.isBelow(referrers.length, SCALE_ROWS / 10);
          const rolled = yield* large.kit.row(referrers[0]!, [p.rollSum]);
          assert.deepEqual(rolled.row.cells[p.rollSum], { type: "number", value: 999 });

          // A definition change queues every row; the mutation computes a bounded share and the
          // background drain the rest, a batch of at most computedDrainRows rows at a time.
          const batches = new Map<string, number[]>();
          for (const [name, scale] of [
            ["large", large],
            ["small", small],
          ] as const) {
            yield* addBackfill(scale);
            const inMutation = yield* takeDequeued(dbPath);
            assert.isAtMost(inMutation.length, computedDrainRows);
            const waiting = yield* queued(dbPath);
            assert.equal(waiting + inMutation.length, scale.rows);
            const drained = yield* observe(service.drainComputed);
            const sizes: number[] = [];
            const perBatch: number[] = [];
            for (const [text, params] of drained.statements) {
              if (/^\s*SELECT page_id, data_source_id FROM spaces_db_computed_dirty/.test(text)) {
                sizes.push(0);
                perBatch.push(0);
              }
              if (sizes.length === 0) continue;
              perBatch[perBatch.length - 1]! += 1;
              if (/^\s*DELETE FROM spaces_db_computed_dirty/.test(text))
                sizes[sizes.length - 1]! += params.length;
            }
            report(`backfill ${name}`, {
              inMutation: inMutation.length,
              batches: sizes.length,
              rowsPerBatch: sizes.slice(0, 3),
              statementsPerBatch: perBatch.slice(0, 3),
            });
            assert.equal(yield* queued(dbPath), 0);
            const recomputed = yield* takeDequeued(dbPath);
            assert.equal(recomputed.length + inMutation.length, scale.rows);
            for (const size of sizes) assert.isAtMost(size, computedDrainRows);
            // Full batches cost the same number of statements, whatever the size of the source.
            batches.set(name, perBatch.slice(0, -2));
          }
          const [a, b] = [batches.get("large")!, batches.get("small")!];
          assert.isAbove(a.length, 0);
          assert.isAbove(b.length, 0);
          assert.isTrue(
            [...a, ...b].every((count) => count === a[0]),
            `${a} ${b}`,
          );
          const value = yield* large.kit.row(large.taskId(10), [NEXT]);
          assert.deepEqual(value.row.cells[NEXT], { type: "number", value: (10 % 13) + 1 });
        }),
      true,
      { backgroundDrain: false },
    ),
  );
});
