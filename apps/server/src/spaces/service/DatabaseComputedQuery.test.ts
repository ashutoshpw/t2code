import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { databaseError, pid } from "./Databases.testkit.ts";
import { cond, ids, seed } from "./DatabaseQuery.testkit.ts";
import { setupWork } from "./DatabaseComputed.testkit.ts";
import { env, fixture } from "./Spaces.testkit.ts";

const asc = (property: C.SpacePropertyId): C.SpaceSort => ({ property, direction: "ascending" });
const desc = (property: C.SpacePropertyId): C.SpaceSort => ({ property, direction: "descending" });

/** A computed property and the stored one it mirrors, by query type. */
const pairs = [
  ["number", pid("cnum001"), ids.points, 'prop("Points")'],
  ["text", pid("ctxt001"), ids.note, 'prop("Note")'],
  ["checkbox", pid("cbool01"), ids.done, 'prop("Done")'],
  ["date", pid("cdate01"), ids.due, 'prop("Due")'],
] as const;

const filters = (computed: C.SpacePropertyId, stored: C.SpacePropertyId, type: string) => {
  const both = (build: (property: C.SpacePropertyId) => C.SpaceFilter) =>
    [build(computed), build(stored)] as const;
  switch (type) {
    case "number":
      return [
        both((p) => cond(p, "equals", 20)),
        both((p) => cond(p, "greater_than", 5)),
        both((p) => cond(p, "less_than_or_equal_to", 0)),
        both((p) => cond(p, "is_empty")),
        both((p) => cond(p, "is_not_empty")),
      ];
    case "text":
      return [
        both((p) => cond(p, "contains", "hello")),
        both((p) => cond(p, "starts_with", "w")),
        both((p) => cond(p, "does_not_equal", "hello")),
        both((p) => cond(p, "is_empty")),
      ];
    case "checkbox":
      return [both((p) => cond(p, "equals", true)), both((p) => cond(p, "equals", false))];
    default:
      return [
        both((p) => cond(p, "on_or_after", "2026-11-11")),
        both((p) => cond(p, "before", "2026-11-11")),
        both((p) => cond(p, "within", { direction: "next", unit: "week" })),
        both((p) => cond(p, "is_empty")),
      ];
  }
};

const groupBy = {
  number: { range: { start: 0, size: 10 } },
  text: "exact",
  checkbox: "checkbox",
  date: "month",
} as const;

const aggregatesOf = {
  number: ["count", "sum", "average", "median", "min", "max", "range", "empty", "count_unique"],
  text: ["count", "count_values", "empty", "percent_not_empty", "count_unique"],
  checkbox: ["count", "checked", "unchecked", "percent_checked"],
  date: ["count", "earliest", "latest", "date_range", "empty"],
} as const;

it.layer(NodeServices.layer)("Spaces computed properties in queries", (it) => {
  it.effect("filters, sorts, groups and aggregates exactly like the stored column it mirrors", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { kit, dataSourceId, query, titles } = yield* seed(dbPath);
        yield* kit.schema(
          dataSourceId,
          pairs.map(([, id, , expression]) => ({
            op: "addProperty" as const,
            property: { id, name: `C ${id}`, type: "formula" as const, config: { expression } },
          })),
        );
        for (const [type, computed, stored] of pairs) {
          for (const [left, right] of filters(computed, stored, type))
            assert.deepEqual(
              titles(yield* query({ filter: left })),
              titles(yield* query({ filter: right })),
              `${type} filter ${JSON.stringify(left)}`,
            );
          for (const direction of [asc, desc])
            assert.deepEqual(
              titles(yield* query({ sorts: [direction(computed)] })),
              titles(yield* query({ sorts: [direction(stored)] })),
              `${type} sort`,
            );
          const grouped = (property: C.SpacePropertyId) =>
            query({
              mode: "groups",
              group: { property, by: groupBy[type] },
              rowsPerGroup: 25,
            }).pipe(
              Effect.map((result) =>
                (result.groups ?? []).map((bucket) => [
                  bucket.key,
                  bucket.count,
                  bucket.rows.map((row) => row.page.title),
                ]),
              ),
            );
          assert.deepEqual(yield* grouped(computed), yield* grouped(stored), `${type} group`);
          const aggregated = (property: C.SpacePropertyId) =>
            query({
              include: { aggregates: true },
              aggregates: aggregatesOf[type].map((fn) => ({ property, function: fn })),
            }).pipe(
              Effect.map((result) =>
                (result.aggregates ?? []).map((a) => [a.function, a.number, a.date]),
              ),
            );
          const computedAggregates = yield* aggregated(computed);
          assert.lengthOf(computedAggregates, aggregatesOf[type].length);
          assert.deepEqual(computedAggregates, yield* aggregated(stored), `${type} aggregates`);
        }
      }),
    ),
  );

  it.effect("keeps views and cursors working on computed sorts across windows", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { kit, service, common, dataSourceId, query, titles } = yield* seed(dbPath);
        yield* kit.schema(dataSourceId, [
          {
            op: "addProperty",
            property: {
              id: pid("cnum001"),
              name: "C",
              type: "formula",
              config: { expression: 'prop("Points")' },
            },
          },
        ]);
        const view = yield* service.createView({
          ...common,
          mutationId: "computed-view",
          dataSourceId,
          name: "By C",
          type: "table",
          filter: { property: "cnum001", operator: "greater_than", value: -10 },
          sorts: [{ property: "cnum001", direction: "ascending" }],
        });
        const first = yield* query({ viewId: view.viewId, limit: 2 });
        const second = yield* query({ viewId: view.viewId, limit: 2, cursor: first.nextCursor! });
        const whole = yield* query({ viewId: view.viewId, limit: 10 });
        assert.deepEqual([...titles(first), ...titles(second)], titles(whole).slice(0, 4));
      }),
    ),
  );

  it.effect("refuses to query volatile and broken computed properties", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { kit, dataSourceId, query } = yield* seed(dbPath);
        yield* kit.schema(dataSourceId, [
          {
            op: "addProperty",
            property: {
              id: pid("clock01"),
              name: "Clock",
              type: "formula",
              config: { expression: "now()" },
            },
          },
          {
            op: "addProperty",
            property: {
              id: pid("dbl0001"),
              name: "Dbl",
              type: "formula",
              config: { expression: 'prop("Points") * 2' },
            },
          },
        ]);
        const reason = (extra: Parameters<typeof query>[0]) =>
          Effect.map(databaseError(query(extra)), (error) => error.reason);
        for (const id of ["clock01"]) {
          const property = pid(id);
          assert.equal(
            yield* reason({ filter: cond(property, "is_empty") }),
            "property_not_queryable",
          );
          assert.equal(yield* reason({ sorts: [asc(property)] }), "property_not_queryable");
          assert.equal(
            yield* reason({ mode: "groups", group: { property } }),
            "property_not_queryable",
          );
          assert.equal(
            yield* reason({
              include: { aggregates: true },
              aggregates: [{ property, function: "count" }],
            }),
            "property_not_queryable",
          );
        }
        // Deleting an input leaves the formula in error: it is refused the same way.
        yield* kit.schema(dataSourceId, [{ op: "removeProperty", propertyId: ids.points }]);
        assert.equal(yield* reason({ sorts: [asc(pid("dbl0001"))] }), "property_not_queryable");
      }),
    ),
  );

  it.effect("evaluates volatile values for the window in the viewer's zone", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { kit, dataSourceId, query, rows } = yield* seed(dbPath);
        yield* kit.schema(dataSourceId, [
          {
            op: "addProperty",
            property: {
              id: pid("hour001"),
              name: "Hour",
              type: "formula",
              config: { expression: 'formatDate(now(), "YYYY-MM-DD HH:mm")' },
            },
          },
        ]);
        yield* kit.schema(dataSourceId, [
          {
            op: "addProperty",
            property: {
              id: pid("next001"),
              name: "Next",
              type: "formula",
              config: { expression: 'prop("Hour") + "!"' },
            },
          },
        ]);
        const next = yield* query({ limit: 1, properties: [pid("next001")] });
        assert.deepEqual(next.rows[0]!.cells["next001"], {
          type: "string",
          value: "2026-11-11 12:00!",
        });
        const hour = (timeZone: string) =>
          query({ timeZone, limit: 1, properties: [pid("hour001")] }).pipe(
            Effect.map((result) => result.rows[0]!.cells["hour001"]),
          );
        assert.deepEqual(yield* hour("UTC"), { type: "string", value: "2026-11-11 12:00" });
        assert.deepEqual(yield* hour("Asia/Tokyo"), { type: "string", value: "2026-11-11 21:00" });
        // rows.get takes the zone too, and rejects an unknown one.
        const read = yield* kit.service.getDatabaseRows({
          ...env,
          pageId: rows[0]!,
          properties: [pid("hour001")],
          timeZone: "America/New_York",
        });
        assert.deepEqual(read.row.cells["hour001"], { type: "string", value: "2026-11-11 07:00" });
        const bad = yield* databaseError(
          kit.service.getDatabaseRows({ ...env, pageId: rows[0]!, timeZone: "Mars/Olympus" }),
        );
        assert.equal(bad.reason, "invalid_time_zone");
      }),
    ),
  );

  it.effect("lists pages inside computed values, and a date formula drives a calendar", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, kit, tasks, created, t, p, addComputed } = yield* setupWork();
        yield* addComputed(tasks, "own0001", "Owner", "formula", {
          expression: 'prop("Project").first()',
        });
        yield* addComputed(tasks, "dd00001", "When", "formula", {
          expression: 'dateAdd(prop("Due"), 2, "days")',
        });
        const read = yield* kit.row(t[0]!, [pid("own0001")]);
        assert.deepEqual(read.row.cells["own0001"], {
          type: "page",
          value: p[0]!,
          dataSourceId: created.dataSourceId,
        });
        assert.equal(read.relatedPages[p[0]!]?.title, "P1");
        const view = yield* service.createView({
          ...common,
          mutationId: "calendar",
          dataSourceId: tasks,
          name: "Calendar",
          type: "calendar",
          layout: { datePropertyId: "dd00001" },
        });
        assert.equal(view.status, "saved");
        const volatile = yield* databaseError(
          kit
            .schema(tasks, [
              {
                op: "addProperty",
                property: {
                  id: pid("now0001"),
                  name: "Now",
                  type: "formula",
                  config: { expression: "now()" },
                },
              },
            ])
            .pipe(
              Effect.flatMap(() =>
                service.createView({
                  ...common,
                  mutationId: "calendar-now",
                  dataSourceId: tasks,
                  name: "Calendar now",
                  type: "calendar",
                  layout: { datePropertyId: "now0001" },
                }),
              ),
            ),
        ).pipe(Effect.map((error) => error.reason));
        assert.equal(volatile, "invalid_view");
      }),
    ),
  );
});
