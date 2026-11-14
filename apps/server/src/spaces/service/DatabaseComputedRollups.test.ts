import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { env, fixture } from "./Spaces.testkit.ts";
import { pid } from "./Databases.testkit.ts";
import { ids, numberValue, setupWork, stringValue } from "./DatabaseComputed.testkit.ts";

const dateValue = (start: string, end?: string) => ({
  type: "date",
  value: { start, ...(end === undefined ? {} : { end }) },
});
const red = { type: "string", value: "Red", color: "red" };
const array = (...value: C.SpaceCellValue[]) => ({ type: "array", value });
type Expected = C.SpaceCellValue | undefined;

/**
 * Projects: P1 has T1 (3, done, due 11-05) and T2 (4, not done, due 11-07..11-09, Red);
 * P2 has T3 (5); P3 has no tasks. Each case is [target, function, P1, P2, P3].
 */
const cases: ReadonlyArray<readonly [string, string, Expected, Expected, Expected]> = [
  [
    ids.est,
    "show_original",
    array(numberValue(3), numberValue(4)),
    array(numberValue(5)),
    undefined,
  ],
  [ids.est, "show_unique", array(numberValue(3), numberValue(4)), array(numberValue(5)), undefined],
  [ids.est, "count_all", numberValue(2), numberValue(1), numberValue(0)],
  [ids.est, "count_values", numberValue(2), numberValue(1), numberValue(0)],
  [ids.est, "count_unique", numberValue(2), numberValue(1), numberValue(0)],
  [ids.est, "count_empty", numberValue(0), numberValue(0), numberValue(0)],
  [ids.est, "count_not_empty", numberValue(2), numberValue(1), numberValue(0)],
  [ids.est, "percent_empty", numberValue(0), numberValue(0), undefined],
  [ids.est, "percent_not_empty", numberValue(1), numberValue(1), undefined],
  [ids.est, "sum", numberValue(7), numberValue(5), numberValue(0)],
  [ids.est, "average", numberValue(3.5), numberValue(5), undefined],
  [ids.est, "median", numberValue(3.5), numberValue(5), undefined],
  [ids.est, "min", numberValue(3), numberValue(5), undefined],
  [ids.est, "max", numberValue(4), numberValue(5), undefined],
  [ids.est, "range", numberValue(1), numberValue(0), undefined],
  [ids.due, "earliest_date", dateValue("2026-11-05"), undefined, undefined],
  [ids.due, "latest_date", dateValue("2026-11-09"), undefined, undefined],
  [ids.due, "date_range", dateValue("2026-11-05", "2026-11-09"), undefined, undefined],
  [ids.due, "count_empty", numberValue(0), numberValue(1), numberValue(0)],
  [ids.done, "checked", numberValue(1), numberValue(0), numberValue(0)],
  [ids.done, "unchecked", numberValue(1), numberValue(1), numberValue(0)],
  [ids.done, "percent_checked", numberValue(0.5), numberValue(0), undefined],
  [ids.done, "percent_unchecked", numberValue(0.5), numberValue(1), undefined],
  [ids.tag, "show_original", array(red), undefined, undefined],
  [ids.tag, "show_unique", array(red), undefined, undefined],
  [ids.tag, "count_values", numberValue(1), numberValue(0), numberValue(0)],
  [ids.tag, "count_empty", numberValue(1), numberValue(1), numberValue(0)],
  [ids.tag, "percent_empty", numberValue(0.5), numberValue(1), undefined],
  [
    "title",
    "show_original",
    array(stringValue("T1"), stringValue("T2")),
    array(stringValue("T3")),
    undefined,
  ],
  ["title", "count_unique", numberValue(2), numberValue(1), numberValue(0)],
];

it.layer(NodeServices.layer)("Spaces rollup functions", (it) => {
  it.effect("computes every rollup function per source type", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, projects, tasks, t, addComputed, cell } = yield* setupWork();
        yield* kit.setCells(tasks, t[1]!, {
          [ids.due]: { start: "2026-11-07", end: "2026-11-09" },
        });
        const rows = (yield* kit.addRows(projects, [{ title: "P3" }])).rows.map(
          (row) => row.pageId,
        );
        const [p1, p2] = (yield* kit.service.queryDatabase({
          ...env,
          dataSourceId: projects,
          mode: "rows",
          timeZone: "UTC",
          limit: 3,
        })).rows.map((row) => row.page.id);
        const p3 = rows[0]!;
        for (const [index, [target, fn]] of cases.entries())
          yield* addComputed(
            projects,
            `rl${String(index).padStart(4, "0")}`,
            `R${index}`,
            "rollup",
            {
              relationPropertyId: ids.tasksOf,
              targetPropertyId: target,
              function: fn,
            },
          );
        for (const [index, [target, fn, one, two, three]] of cases.entries()) {
          const id = pid(`rl${String(index).padStart(4, "0")}`);
          const label = `${target} ${fn}`;
          assert.deepEqual(yield* cell(p1!, id), one, `${label} P1`);
          assert.deepEqual(yield* cell(p2!, id), two, `${label} P2`);
          assert.deepEqual(yield* cell(p3, id), three, `${label} P3`);
        }
      }),
    ),
  );

  it.effect("rolls up a relation into far pages and a formula into its result", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, projects, tasks, p, t, addComputed, cell, property } = yield* setupWork();
        // A rollup of the back relation shows pages two hops away as pages, countable.
        yield* addComputed(tasks, "twice01", "Twice", "formula", {
          expression: 'prop("Estimate") * 2',
        });
        yield* addComputed(projects, "rtwice1", "TwiceSum", "rollup", {
          relationPropertyId: ids.tasksOf,
          targetPropertyId: "twice01",
          function: "sum",
        });
        assert.deepEqual(yield* cell(p[0]!, pid("rtwice1")), numberValue(14));
        yield* kit.setCells(tasks, t[0]!, { [ids.est]: 10 });
        assert.deepEqual(yield* cell(p[0]!, pid("rtwice1")), numberValue(28));
        yield* addComputed(tasks, "far0001", "Siblings", "rollup", {
          relationPropertyId: ids.project,
          targetPropertyId: ids.tasksOf,
          function: "show_original",
        });
        const siblings = (yield* cell(t[0]!, pid("far0001"))) as {
          type: string;
          value: Array<{ type: string; value: string }>;
        };
        assert.equal(siblings.type, "array");
        assert.deepEqual(siblings.value.map((item) => item.value).sort(), [t[0]!, t[1]!].sort());
        assert.equal((yield* property(tasks, "far0001")).computed?.queryType, "text");
      }),
    ),
  );

  it.effect("keeps a failed rollup linked to its target so it recovers", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, projects, tasks, p, addComputed, cell, property } = yield* setupWork();
        yield* addComputed(projects, "rsum001", "Sum", "rollup", {
          relationPropertyId: ids.tasksOf,
          targetPropertyId: ids.est,
          function: "sum",
        });
        assert.deepEqual(yield* cell(p[0]!, pid("rsum001")), numberValue(7));
        yield* kit.schema(tasks, [{ op: "changePropertyType", propertyId: ids.est, type: "text" }]);
        assert.isDefined((yield* property(projects, "rsum001")).computed?.error);
        yield* kit.schema(tasks, [
          { op: "changePropertyType", propertyId: ids.est, type: "number" },
        ]);
        assert.isUndefined((yield* property(projects, "rsum001")).computed?.error);
        assert.deepEqual(yield* cell(p[0]!, pid("rsum001")), numberValue(7));
        yield* kit.schema(tasks, [{ op: "removeProperty", propertyId: ids.est }]);
        assert.isDefined((yield* property(projects, "rsum001")).computed?.error);
        yield* kit.schema(tasks, [{ op: "restoreProperty", propertyId: ids.est }]);
        assert.isUndefined((yield* property(projects, "rsum001")).computed?.error);
        assert.deepEqual(yield* cell(p[0]!, pid("rsum001")), numberValue(7));
      }),
    ),
  );

  it.effect("reads the current row's own properties when a relation contains the row itself", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, tasks, t, addComputed, cell } = yield* setupWork();
        yield* kit.schema(tasks, [
          {
            op: "addProperty",
            property: {
              id: pid("self001"),
              name: "Related",
              type: "relation",
              config: { dataSourceId: tasks, limit: "many" },
            },
          },
        ]);
        yield* kit.setCells(tasks, t[0]!, { [pid("self001")]: [t[0]!, t[1]!] });
        yield* addComputed(tasks, "selfsum", "SelfSum", "rollup", {
          relationPropertyId: pid("self001"),
          targetPropertyId: ids.est,
          function: "sum",
        });
        yield* addComputed(tasks, "selff01", "SelfF", "formula", {
          expression: 'prop("Related").map(current.prop("Estimate")).sum()',
        });
        assert.deepEqual(yield* cell(t[0]!, pid("selfsum")), numberValue(7));
        assert.deepEqual(yield* cell(t[0]!, pid("selff01")), numberValue(7));
      }),
    ),
  );
});
