import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { DRIVE_BELOW, DRIVE_BELOW_ALL } from "../databases/query/Filter.ts";
import { databaseKit } from "./Databases.testkit.ts";
import { cond } from "./DatabaseQuery.testkit.ts";
import {
  SCALE_ROWS,
  buildScale,
  observe,
  p,
  pagesVisited,
  plansOf,
  report,
  windowStatement,
} from "./DatabaseScale.testkit.ts";
import { boot, fixture } from "./Spaces.testkit.ts";

const asc = (property: C.SpacePropertyId): C.SpaceSort => ({ property, direction: "ascending" });
const LIMIT = 100;

interface Shape {
  readonly name: string;
  readonly filter: C.SpaceFilter;
  readonly sorts: readonly C.SpaceSort[];
  /** The conjuncts a cell index can drive, one probe each; the fixture size decides which win. */
  readonly drivable: readonly C.SpaceFilter[];
}

const shape = (
  name: string,
  conjuncts: readonly C.SpaceFilter[],
  sorts: readonly C.SpaceSort[] = [],
  drivable: readonly C.SpaceFilter[] = conjuncts,
): Shape => ({
  name,
  filter: conjuncts.length === 1 ? conjuncts[0]! : { and: conjuncts },
  sorts,
  drivable,
});

const broadStatus = cond(p.status, "equals", "sto0");
const everyRow = cond(p.n[2]!, "greater_than_or_equal_to", 0);
const narrowSelect = cond(p.s200, "equals", "bo007");
const numberRange = [
  cond(p.n[4]!, "greater_than_or_equal_to", 10),
  cond(p.n[4]!, "less_than", 60),
] as const;
const broadComputed = cond(p.fNum, "greater_than", 500);
const shapes: readonly Shape[] = [
  shape("broad select", [broadStatus]),
  shape("number matching every row", [everyRow]),
  shape("narrow select", [narrowSelect]),
  shape("narrow number range", numberRange, [], [{ and: numberRange }]),
  shape("broad and narrow together", [broadStatus, narrowSelect]),
  shape("broad, sorted on another property", [broadStatus], [asc(p.n[3]!)]),
  shape("narrow, sorted on another property", [narrowSelect], [asc(p.n[3]!)]),
  shape("broad and narrow together, sorted", [broadStatus, narrowSelect], [asc(p.n[3]!)]),
  shape("broad computed", [broadComputed]),
  shape("narrow computed", [cond(p.fNum, "greater_than", 2060)]),
  shape("broad computed, sorted on itself", [broadComputed], [asc(p.fNum)]),
];

it.layer(NodeServices.layer)("Spaces database filters at scale", (it) => {
  it.effect(
    "walks the row order for a broad filter and starts from the cells for a narrow one",
    () =>
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
            const s = yield* buildScale(host, { prefix: "big", rows: SCALE_ROWS, bodies: 40 });
            const failures: string[] = [];
            for (const shape of shapes) {
              const seen = yield* observe(
                s.query({
                  filter: shape.filter,
                  sorts: shape.sorts,
                  limit: LIMIT,
                  include: { total: true },
                }),
              );
              const matches = seen.result.total!;
              const statement = windowStatement(seen.statements)!;
              const plan = (yield* plansOf(dbPath, [statement])).join("\n");
              const visited = pagesVisited(dbPath, statement);
              const below = shape.sorts.length > 0 ? DRIVE_BELOW_ALL : DRIVE_BELOW;
              const probes = seen.statements.filter(
                ([text, params]) =>
                  /SELECT COUNT\(\*\) AS n FROM \(SELECT c\.page_id/.test(text) &&
                  params.includes(below),
              ).length;
              // A conjunct drives the search when it alone finds fewer cells than the cap.
              let drives = false;
              for (const conjunct of shape.drivable)
                drives ||=
                  ((yield* s.query({ filter: conjunct, limit: 1, include: { total: true } }))
                    .total ?? 0) < below;
              report(shape.name, { matches, visited, probes, drives, plan });
              const fail = (why: string) => failures.push(`${shape.name}: ${why}\n${plan}`);
              if (probes !== shape.drivable.length)
                fail(`${probes} bounded probes, wanted ${shape.drivable.length}`);
              const materialized = /LIST SUBQUERY/.test(plan);
              if (drives) {
                // The candidates are looked up by key: fewer than the cap, not every row.
                if (!materialized) fail("a narrow filter does not start from the cell index");
                if (visited >= below) fail(`${visited} rows visited`);
              } else {
                if (materialized) fail("a broad filter materialises its match set");
                if (shape.sorts.length === 0) {
                  if (/TEMP B-TREE FOR ORDER BY/.test(plan)) fail("the default order is sorted");
                  if (!/SEARCH p USING INDEX spaces_pages_rows/.test(plan))
                    fail("the default order does not walk the row index");
                  // The walk stops after the window: about (LIMIT + 1) / (matches / rows) rows.
                  const bound = 2 * Math.ceil(((LIMIT + 1) * SCALE_ROWS) / matches);
                  if (visited > bound) fail(`${visited} rows visited, at most ${bound}`);
                } else if (visited > SCALE_ROWS) fail(`${visited} rows visited`);
              }
              // The strategy never changes the rows: the `or` form is never driven.
              const direct = seen.result;
              const plain = yield* s.query({
                filter: { or: [shape.filter] },
                sorts: shape.sorts,
                limit: LIMIT,
                include: { total: true },
              });
              assert.deepEqual(
                direct.rows.map((row) => row.page.id),
                plain.rows.map((row) => row.page.id),
                shape.name,
              );
              assert.equal(direct.total, plain.total, shape.name);
            }
            assert.deepEqual(failures, []);
          }),
        true,
        { backgroundDrain: false },
      ),
  );
});
