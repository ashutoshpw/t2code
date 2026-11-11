import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import * as Statement from "effect/sql/Statement";
import { databaseError, limitError } from "./Databases.testkit.ts";
import { bulkRows, cond, ids, options, seed } from "./DatabaseQuery.testkit.ts";
import { fixture } from "./Spaces.testkit.ts";

const titleId = C.SpacePropertyId.make("title");
const agg = (property: C.SpacePropertyId, name: C.SpaceKnownAggregate["function"]) => ({
  property,
  function: name,
});
const DAY = 86_400_000;

type Expected = number | { readonly start: string; readonly hasTime: boolean } | undefined;
type Row = readonly [C.SpacePropertyId, C.SpaceKnownAggregate["function"], Expected];

// The seven rows: points 10, 20, 30, none, 20, -5, 0; seven titles with one empty.
const table: readonly Row[] = [
  [ids.points, "count", 7],
  [ids.points, "count_values", 6],
  [ids.points, "count_unique", 5],
  [ids.points, "empty", 1],
  [ids.points, "not_empty", 6],
  [ids.points, "percent_empty", 1 / 7],
  [ids.points, "percent_not_empty", 6 / 7],
  [ids.points, "sum", 75],
  [ids.points, "average", 12.5],
  [ids.points, "median", 15],
  [ids.points, "min", -5],
  [ids.points, "max", 30],
  [ids.points, "range", 35],
  [ids.done, "checked", 3],
  [ids.done, "unchecked", 4],
  [ids.done, "percent_checked", 3 / 7],
  [ids.done, "percent_unchecked", 4 / 7],
  [ids.tags, "count_values", 8],
  [ids.tags, "count_unique", 3],
  [ids.tags, "empty", 2],
  [ids.tags, "not_empty", 5],
  [ids.prio, "count_unique", 3],
  [ids.prio, "empty", 1],
  [ids.state, "not_empty", 6],
  [titleId, "count_values", 6],
  [titleId, "empty", 1],
  [titleId, "count_unique", 6],
  [ids.note, "count_unique", 4],
  [ids.project, "count_values", 4],
  [ids.project, "count_unique", 2],
  [ids.project, "not_empty", 3],
  [ids.files, "count_values", 2],
  [ids.due, "earliest", { start: "2026-11-09", hasTime: false }],
  [ids.due, "latest", { start: "2026-12-25", hasTime: false }],
  [ids.due, "date_range", 46 * DAY],
  [ids.due, "count_unique", 6],
  [ids.created, "earliest", { start: "2026-11-05T10:00:00.000Z", hasTime: true }],
  [ids.created, "latest", { start: "2026-11-11T10:00:00.000Z", hasTime: true }],
  [ids.edited, "date_range", 6 * DAY + 3_600_000],
  [ids.number, "count", 7],
];

const read = (
  result: C.SpaceDatabaseQueryResult,
  property: C.SpacePropertyId,
  name: string,
): Expected => {
  const found = result.aggregates?.find((a) => a.property === property && a.function === name);
  return found?.date ?? found?.number;
};

it.layer(NodeServices.layer)("Spaces database query aggregates", (it) => {
  it.effect("computes every function over the filtered rows", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query } = yield* seed(dbPath);
        const result = yield* query({
          include: { aggregates: true },
          aggregates: table.map(([property, name]) => agg(property, name)),
        });
        for (const [property, name, expected] of table)
          assert.deepEqual(read(result, property, name), expected, `${property} ${name}`);
        assert.lengthOf(result.aggregates ?? [], table.length);

        // Aggregates follow the filter: only the two low-priority rows (points 10 and 20).
        const low = yield* query({
          include: { aggregates: true, total: true },
          filter: cond(ids.prio, "equals", options.low),
          aggregates: [agg(ids.points, "sum"), agg(ids.points, "median"), agg(ids.points, "count")],
        });
        assert.equal(low.total, 2);
        assert.equal(read(low, ids.points, "sum"), 30);
        assert.equal(read(low, ids.points, "median"), 15);
        // An odd count takes the middle value.
        const three = yield* query({
          include: { aggregates: true },
          filter: cond(ids.points, "greater_than_or_equal_to", 10),
          aggregates: [agg(ids.points, "median"), agg(ids.points, "count_values")],
        });
        assert.equal(read(three, ids.points, "median"), 20);
        assert.equal(read(three, ids.points, "count_values"), 4);
        // Timed dates keep their time.
        const timed = yield* query({
          include: { aggregates: true },
          filter: cond(ids.due, "after", "2026-11-11T12:00:00Z"),
          aggregates: [agg(ids.due, "earliest"), agg(ids.due, "latest")],
        });
        assert.deepEqual(read(timed, ids.due, "earliest"), {
          start: "2026-11-11T23:30:00.000Z",
          hasTime: true,
        });
        assert.deepEqual(read(timed, ids.due, "latest"), { start: "2026-12-25", hasTime: false });
      }),
    ),
  );

  it.effect("computes group medians in a fixed number of statements", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, dataSourceId, spaceId } = yield* seed(dbPath);
        yield* bulkRows({ dbPath, dataSourceId, spaceId, count: 300, prefix: "Med" });
        const group = { property: ids.points, by: { range: { start: 0, size: 1 } } } as const;
        let statements = 0;
        const observe: Statement.Transformer = (statement) => {
          statements++;
          return Effect.succeed(statement);
        };
        const run = (aggregates: C.SpaceKnownAggregate[]) => {
          statements = 0;
          return query({ mode: "groups", group, include: { aggregates: true }, aggregates }).pipe(
            Effect.provideService(Statement.CurrentTransformer, observe),
          );
        };
        const plain = yield* run([agg(ids.points, "sum")]);
        const base = statements;
        const result = yield* run([agg(ids.points, "median")]);
        assert.isAbove(result.groups?.length ?? 0, 100);
        // One extra statement per level (overall and group), however many buckets there are.
        assert.isAtMost(statements, base + 2);
        // Each unit bucket holds equal values, so its median is its start.
        for (const bucket of result.groups ?? [])
          if (bucket.key.kind === "number_range")
            assert.equal(bucket.aggregates?.[0]?.number, bucket.key.start);
        assert.equal(plain.groups?.length, result.groups?.length);
      }),
    ),
  );

  it.effect("has no value for an empty set and nothing unless asked", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query } = yield* seed(dbPath);
        const none = yield* query({
          include: { aggregates: true, total: true },
          filter: cond(ids.points, "greater_than", 1000),
          aggregates: [
            agg(ids.points, "count"),
            agg(ids.points, "sum"),
            agg(ids.points, "average"),
            agg(ids.points, "median"),
            agg(ids.points, "min"),
            agg(ids.points, "percent_empty"),
            agg(ids.due, "earliest"),
          ],
        });
        assert.equal(none.total, 0);
        assert.deepEqual(none.aggregates, [
          { property: ids.points, function: "count", number: 0 },
          { property: ids.points, function: "sum", number: 0 },
          { property: ids.points, function: "average" },
          { property: ids.points, function: "median" },
          { property: ids.points, function: "min" },
          { property: ids.points, function: "percent_empty" },
          { property: ids.due, function: "earliest" },
        ]);
        const off = yield* query({ aggregates: [agg(ids.points, "sum")] });
        assert.isUndefined(off.aggregates);
        assert.isUndefined(off.total);
      }),
    ),
  );

  it.effect("aggregates per bucket in groups mode, including sub-groups", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query } = yield* seed(dbPath);
        const grouped = yield* query({
          mode: "groups",
          group: { property: ids.prio },
          subGroup: { property: ids.done },
          include: { aggregates: true, total: true },
          aggregates: [agg(ids.points, "sum"), agg(ids.points, "count")],
        });
        const sums = (grouped.groups ?? []).map((bucket) => [
          bucket.count,
          bucket.aggregates?.map((a) => a.number),
          (bucket.subGroups ?? []).map((sub) => sub.aggregates?.map((a) => a.number)),
        ]);
        // low: Alpha 10 (done), echo 20; med: bravo 20, Foxtrot -5 (done); high: Charlie 30 (done), "" 0; empty: Delta.
        assert.deepEqual(sums, [
          [
            2,
            [30, 2],
            [
              [20, 1],
              [10, 1],
            ],
          ],
          [
            2,
            [15, 2],
            [
              [20, 1],
              [-5, 1],
            ],
          ],
          [
            2,
            [30, 2],
            [
              [0, 1],
              [30, 1],
            ],
          ],
          [
            1,
            [0, 1],
            [
              [0, 1],
              [0, 0],
            ],
          ],
        ]);
        assert.deepEqual(
          grouped.aggregates?.map((a) => a.number),
          [75, 7],
        );
        assert.equal(grouped.total, 7);
        // A row of a multi-valued group lands in each of its buckets: a=Alpha, b=Alpha+bravo, c=echo+"".
        const tags = yield* query({
          mode: "groups",
          group: { property: ids.tags },
          include: { aggregates: true },
          aggregates: [agg(ids.points, "sum")],
        });
        assert.deepEqual(
          (tags.groups ?? []).map((bucket) => bucket.aggregates?.[0]?.number),
          [10, 30, 20, 25],
        );
      }),
    ),
  );

  it.effect("uses the view's column aggregates by default and rejects illegal ones", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, service, common, dataSourceId } = yield* seed(dbPath);
        const view = yield* service.createView({
          ...common,
          mutationId: "agg-view",
          dataSourceId,
          name: "Totals",
          type: "table",
          properties: [
            { propertyId: ids.points, visible: true, aggregate: "sum" },
            { propertyId: ids.prio, visible: false },
          ],
          beforeViewId: null,
        });
        const result = yield* query({ viewId: view.viewId, include: { aggregates: true } });
        assert.deepEqual(result.aggregates, [
          { property: ids.points, function: "sum", number: 75 },
        ]);
        assert.deepEqual(Object.keys(result.rows[0]!.cells).sort(), ["points", "title"]);
        const illegal = (aggregates: readonly C.SpaceAggregate[]) =>
          Effect.map(
            databaseError(query({ include: { aggregates: true }, aggregates })),
            (e) => e.reason,
          );
        assert.equal(yield* illegal([agg(ids.note, "sum")]), "invalid_aggregate");
        assert.equal(yield* illegal([agg(ids.done, "count_values")]), "invalid_aggregate");
        assert.equal(yield* illegal([agg(ids.calc, "count")]), "property_not_queryable");
        const many = Array.from({ length: 51 }, () => agg(ids.points, "count"));
        assert.equal(
          yield* limitError(query({ include: { aggregates: true }, aggregates: many })),
          "databases.maxAggregates",
        );
      }),
    ),
  );
});
