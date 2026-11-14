import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { databaseLimits } from "../CorePolicy.ts";
import { databaseKit } from "./Databases.testkit.ts";
import { cond } from "./DatabaseQuery.testkit.ts";
import {
  SCALE_ROWS,
  SMALL_ROWS,
  type Scale,
  buildScale,
  bytesOf,
  engine,
  observe,
  p,
  plansOf,
  relatedChunks,
  report,
  scans,
} from "./DatabaseScale.testkit.ts";
import { boot, env, fixture } from "./Spaces.testkit.ts";

const BODIES = SCALE_ROWS >= 10_000 ? 200 : 40;
const asc = (property: C.SpacePropertyId): C.SpaceSort => ({ property, direction: "ascending" });
const agg = (property: C.SpacePropertyId, fn: string): C.SpaceAggregate => ({
  property,
  function: fn,
});

/** The 30 aggregated properties of the aggregate shape. */
const thirty: readonly C.SpaceAggregate[] = [
  ...p.n.map((id) => agg(id, "sum")),
  ...p.t.map((id) => agg(id, "count_values")),
  ...[p.s1, p.s2, p.s200, p.m1, p.m2, p.status].map((id) => agg(id, "count_unique")),
  ...p.d.map((id) => agg(id, "earliest")),
  ...p.c.map((id) => agg(id, "checked")),
  agg(p.url, "count_values"),
  agg(p.email, "count_values"),
  agg(p.project, "count_values"),
  agg(p.parent, "count_values"),
  agg(p.rollSum, "sum"),
  agg(p.rollKids, "sum"),
  agg(p.fNum, "sum"),
  agg(p.fText, "count_values"),
  agg(p.fDate, "earliest"),
];

type Shape = (s: Scale) => Effect.Effect<unknown, C.SpaceServiceError>;
interface Case {
  readonly name: string;
  readonly run: Shape;
  /** Statements allowed per call, at every size. */
  readonly most: number;
  /** The row statement must not walk every row of the data source. */
  readonly selective?: boolean;
  /** Statements that may build the filtered row set; each builds it once. */
  readonly materialized?: number;
}

const stored = (s: Scale) =>
  s.query({
    filter: {
      and: [cond(p.n[0]!, "greater_than_or_equal_to", 200), cond(p.s1, "equals", "s1o1")],
    },
    sorts: [asc(p.n[3]!)],
    limit: 100,
    include: { total: true },
  });

/** `narrow` keeps a thirteenth of the rows, so 200 parents with text sub-groups fit the response cap. */
const board =
  (group: C.SpaceGroup, subGroup?: C.SpaceGroup, narrow = false) =>
  (s: Scale) =>
    s.query({
      mode: "groups",
      ...(narrow ? { filter: cond(p.n[2]!, "equals", 4) } : {}),
      group,
      ...(subGroup === undefined ? {} : { subGroup }),
      rowsPerGroup: 25,
      include: { total: true },
    });

const month = (property: C.SpacePropertyId, part: boolean) => (s: Scale) =>
  s.query({
    filter: {
      and: [
        cond(property, "on_or_before", "2026-03-31", part ? "start" : undefined),
        cond(property, "on_or_after", "2026-03-01", part ? "end" : undefined),
      ],
    },
    sorts: [asc(property)],
    limit: 100,
  });

const cases: readonly Case[] = [
  { name: "flat window, two stored filters, one sort, total", run: stored, most: 8 },
  {
    name: "flat window, filter and sort on a formula and a rollup",
    run: (s) =>
      s.query({
        filter: {
          and: [cond(p.fNum, "greater_than", 500), cond(p.rollSum, "greater_than_or_equal_to", 0)],
        },
        sorts: [asc(p.fNum)],
        limit: 100,
        include: { total: true },
      }),
    most: 8,
  },
  {
    name: "equality on a 200-option select",
    run: (s) => s.query({ filter: cond(p.s200, "equals", "bo007"), limit: 100 }),
    most: 8,
    selective: true,
  },
  {
    name: "number range on a stored number",
    run: (s) =>
      s.query({
        filter: {
          and: [cond(p.n[4]!, "greater_than_or_equal_to", 10), cond(p.n[4]!, "less_than", 60)],
        },
        sorts: [asc(p.n[4]!)],
        limit: 100,
      }),
    most: 8,
    selective: true,
  },
  {
    name: "board, 200 buckets, previews",
    run: board({ property: p.s200 }),
    most: 10,
  },
  {
    name: "board with sub-group",
    run: board({ property: p.s200 }, { property: p.s1 }),
    most: 10,
  },
  {
    name: "board with a text sub-group under few parents",
    run: board({ property: p.s1 }, { property: p.t[2]!, by: "exact" }, true),
    most: 10,
  },
  {
    name: "board with a text sub-group under 200 parents",
    run: board({ property: p.s200 }, { property: p.t[2]!, by: "exact" }, true),
    most: 10,
  },
  {
    name: "board over a text property cut at the bucket cap",
    run: board({ property: p.t[0]!, by: "exact" }),
    most: 10,
  },
  {
    name: "one bucket's next window",
    run: (s) =>
      s.query({
        group: { property: p.s200 },
        scope: { group: { kind: "option", optionId: "bo007" } },
        limit: 100,
      }),
    most: 6,
  },
  {
    name: "aggregates over 30 properties",
    run: (s) =>
      s.query({ limit: 1, aggregates: thirty, include: { total: true, aggregates: true } }),
    most: 8,
    materialized: 2,
  },
  {
    name: "aggregates over two properties",
    run: (s) =>
      s.query({
        limit: 1,
        aggregates: [agg(p.n[0]!, "sum"), agg(p.d[0]!, "earliest")],
        include: { total: true, aggregates: true },
      }),
    most: 8,
  },
  {
    name: "aggregates over 30 properties per bucket",
    run: (s) =>
      s.query({
        mode: "groups",
        group: { property: p.s1 },
        aggregates: thirty,
        include: { aggregates: true },
        rowsPerGroup: 5,
      }),
    most: 12,
  },
  { name: "calendar month on a date", run: month(p.d[0]!, true), most: 8 },
  { name: "calendar month on a date range", run: month(p.d[1]!, true), most: 8 },
  {
    name: "one week of a stored date",
    run: (s) =>
      s.query({
        filter: {
          and: [cond(p.d[0]!, "on_or_after", "2026-06-01"), cond(p.d[0]!, "before", "2026-06-08")],
        },
        sorts: [asc(p.d[0]!)],
        limit: 100,
      }),
    most: 8,
    selective: true,
  },
  {
    name: "sub-items of one parent",
    run: (s) => s.query({ scope: { parentRowId: s.taskId(1) }, limit: 100 }),
    most: 8,
  },
  {
    name: "top-level rows with child counts and covers",
    run: (s) => s.query({ scope: { parentRowId: null }, limit: 100, include: { cover: true } }),
    most: 8,
  },
  {
    name: "getDatabase",
    run: (s) => s.kit.service.getDatabase({ ...env, databaseId: s.databaseId }),
    most: 12,
  },
  { name: "listDatabases", run: (s) => s.kit.service.listDatabases({ ...env }), most: 8 },
];

const pagesRows = /SEARCH p USING (COVERING )?INDEX spaces_pages_rows/;

it.layer(NodeServices.layer)("Spaces databases at scale", (it) => {
  it.effect("answers every read shape in statements that do not grow with the data source", () =>
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
            bodies: Math.min(BODIES, 40),
          });
          const failures: string[] = [];
          const counts = new Map<string, number>();
          for (const shape of cases) {
            const big = yield* observe(shape.run(large));
            const little = yield* observe(shape.run(small));
            const bigScans = yield* scans(dbPath, big.statements);
            const bigPlans = yield* plansOf(dbPath, big.statements);
            report(shape.name, {
              statements: engine(big.statements).length,
              preamble: big.statements.length - engine(big.statements).length,
              heads: big.statements.map(([t]) => t.replace(/\s+/g, " ").slice(0, 90)),
              small: engine(little.statements).length,
              bytes: bytesOf(big.result),
              scans: bigScans,
              plan: shape.selective === true ? bigPlans : undefined,
              drivenByAllRows: bigPlans.filter((line) => pagesRows.test(line)).length,
            });
            const own = engine(big.statements).length;
            if (own > shape.most)
              failures.push(`${shape.name}: ${own} statements, at most ${shape.most}`);
            if (own !== engine(little.statements).length)
              failures.push(
                `${shape.name}: ${own} statements at ${SCALE_ROWS} rows, ${engine(little.statements).length} at ${SMALL_ROWS}`,
              );
            // Related titles come in chunks of 200 ids taken from the window's own cells: at most
            // 100 rows with up to 11 related pages each.
            if (relatedChunks(big.statements) > 6)
              failures.push(`${shape.name}: ${relatedChunks(big.statements)} related-page chunks`);
            const materialized = big.statements.filter(([text]) => text.includes("MATERIALIZED"));
            if (
              shape.materialized !== undefined &&
              (materialized.length > shape.materialized ||
                materialized.some(([text]) => text.split("MATERIALIZED").length > 2))
            )
              failures.push(
                `${shape.name}: the filtered rows are built ${materialized.length} times`,
              );
            counts.set(shape.name, own);
            if (bigScans.length > 0)
              failures.push(`${shape.name}: full scans ${bigScans.join("; ")}`);
            if (bytesOf(big.result) > databaseLimits.maxQueryResponseBytes)
              failures.push(`${shape.name}: ${bytesOf(big.result)} bytes`);
            if (shape.selective === true && bigPlans.some((line) => pagesRows.test(line)))
              failures.push(`${shape.name}: the row statement walks every row of the data source`);
          }
          // The sub-group labels cost the same under 4 parents as under 200.
          if (
            counts.get("board with a text sub-group under few parents") !==
            counts.get("board with a text sub-group under 200 parents")
          )
            failures.push("sub-group labels grow with the number of parent buckets");
          if (
            counts.get("aggregates over 30 properties") !==
            counts.get("aggregates over two properties")
          )
            failures.push("aggregate statements grow with the number of properties");
          assert.deepEqual(failures, []);
        }),
      true,
      { backgroundDrain: false },
    ),
  );

  it.effect("keeps the windows, buckets and aggregates within their caps", () =>
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
          const s = yield* buildScale(host, { prefix: "big", rows: SCALE_ROWS, bodies: BODIES });
          const cap = databaseLimits.maxQueryRows;
          // A flat window with a total, and its follow-up by cursor.
          const first = yield* observe(stored(s));
          const firstResult = first.result;
          assert.isAtMost(firstResult.rows.length, cap);
          assert.isNotNull(firstResult.nextCursor);
          const next = yield* observe(
            s.query({
              filter: {
                and: [cond(p.n[0]!, "greater_than_or_equal_to", 200), cond(p.s1, "equals", "s1o1")],
              },
              sorts: [asc(p.n[3]!)],
              limit: 100,
              cursor: firstResult.nextCursor!,
            }),
          );
          assert.equal(next.statements.length, first.statements.length - 1);
          // Filter and sort on computed properties read stored cells: sorted ascending, filter held.
          const computed = yield* s.query({
            filter: cond(p.fNum, "greater_than", 500),
            sorts: [asc(p.fNum)],
            properties: [p.fNum],
            limit: 100,
          });
          const values = computed.rows.map((row) => (row.cells[p.fNum] as { value: number }).value);
          assert.isTrue(values.every((value) => value > 500));
          assert.deepEqual(
            values,
            [...values].sort((a, b) => a - b),
          );
          // More buckets than the cap: cut and flagged.
          const text = yield* s.query({
            mode: "groups",
            group: { property: p.t[0]!, by: "exact" },
            rowsPerGroup: 1,
          });
          assert.lengthOf(text.groups!, databaseLimits.maxGroupBuckets);
          assert.isTrue(text.groupsTruncated);
          const sel = yield* s.query({
            mode: "groups",
            group: { property: p.s200 },
            rowsPerGroup: 25,
          });
          // 200 options and the empty bucket, which is no truncation.
          assert.lengthOf(sel.groups!, 201);
          assert.isAtMost(
            sel.groups!.reduce((n, bucket) => n + bucket.rows.length, 0),
            cap,
          );
          // A text sub-group with more than 200 values under one parent is cut per parent.
          const nested = yield* s.query({
            mode: "groups",
            group: { property: p.s1 },
            subGroup: { property: p.t[3]!, by: "exact" },
            rowsPerGroup: 1,
          });
          assert.isTrue(nested.groupsTruncated);
          for (const parent of nested.groups!)
            assert.isAtMost(parent.subGroups!.length, databaseLimits.maxGroupBuckets);
          // A calendar month fills 500 items in at most five windows.
          let cursor: C.SpaceCursor | null | undefined;
          let items = 0;
          let windows = 0;
          do {
            const month = yield* s.query({
              filter: { and: [cond(p.d[0]!, "on_or_after", "2026-01-01", "end")] },
              sorts: [asc(p.d[0]!)],
              limit: 100,
              ...(cursor ? { cursor } : {}),
            });
            items += month.rows.length;
            windows++;
            cursor = month.nextCursor;
          } while (cursor && items < 500);
          assert.isAtMost(windows, 5);
          // Each aggregate matches the arithmetic of its column.
          const sums = yield* s.query({
            limit: 1,
            aggregates: [agg(p.n[4]!, "sum"), agg(p.n[2]!, "sum")],
            include: { aggregates: true },
          });
          const n = SCALE_ROWS;
          assert.deepEqual(
            sums.aggregates!.map((a) => a.number),
            [
              (n * (n + 1)) / 2,
              Array.from({ length: n }, (_, k) => (k + 1) % 13).reduce((a, b) => a + b, 0),
            ],
          );
          // Covers: only rows with an image first or at block 500 have one.
          const covers = yield* s.query({ limit: 8, include: { cover: true } });
          assert.deepEqual(
            covers.rows.map((row) => row.cover?.assetId ?? null),
            Array.from({ length: 8 }, (_, k) => ((k + 1) % 4 === 3 ? null : `asset-${k + 1}`)),
          );
          // One cover statement and one child-count statement per chunk of ids, and covers read a
          // block's payload only after the asset reference table matched it.
          const extras = yield* observe(
            s.query({ scope: { parentRowId: null }, limit: 100, include: { cover: true } }),
          );
          const coverStatements = extras.statements.filter(([t]) =>
            t.includes("spaces_block_asset_refs"),
          );
          assert.lengthOf(coverStatements, 1);
          assert.lengthOf(
            extras.statements.filter(([t]) => t.includes("GROUP BY c.ref")),
            1,
          );
          const coverPlan = yield* plansOf(dbPath, coverStatements);
          assert.isTrue(
            coverPlan.some((line) => /SEARCH r USING .*\(block_id=\?\)/.test(line)),
            coverPlan.join("\n"),
          );
          assert.isTrue(
            coverPlan.some((line) => /SEARCH b USING .*spaces_blocks_children/.test(line)),
            coverPlan.join("\n"),
          );
          // A conjunct that starts from the cell indexes finds the same rows as the plain test.
          const equivalents: readonly C.SpaceFilter[] = [
            cond(p.n[0]!, "greater_than_or_equal_to", 200),
            {
              and: [cond(p.n[4]!, "greater_than_or_equal_to", 10), cond(p.n[4]!, "less_than", 60)],
            },
            cond(p.s1, "equals", "s1o1"),
            cond(p.status, "equals", "sto2"),
            cond(p.m1, "contains", "m1o2"),
            cond(p.s200, "equals", "bo007"),
            {
              and: [
                cond(p.d[0]!, "on_or_after", "2026-03-01"),
                cond(p.d[0]!, "before", "2026-03-15"),
                cond(p.n[2]!, "equals", 4),
              ],
            },
            {
              and: [
                cond(p.d[1]!, "on_or_before", "2026-05-01", "start"),
                cond(p.d[1]!, "on_or_after", "2026-04-01", "end"),
              ],
            },
            {
              and: [
                cond(p.d[2]!, "after", "2026-02-01T00:00:00Z"),
                cond(p.fNum, "greater_than", 900),
              ],
            },
          ];
          for (const filter of equivalents) {
            const read = (extra: C.SpaceFilter) =>
              s
                .query({
                  filter: extra,
                  sorts: [asc(p.n[4]!)],
                  limit: 100,
                  include: { total: true },
                })
                .pipe(
                  Effect.map((r) => [
                    r.total,
                    r.rows.map((row) => row.page.id),
                    r.nextCursor !== null,
                  ]),
                );
            const direct = yield* read(filter);
            assert.deepEqual(direct, yield* read({ or: [filter] }), JSON.stringify(filter));
            assert.isAbove(direct[0] as number, 0, JSON.stringify(filter));
          }
        }),
      true,
      { backgroundDrain: false },
    ),
  );
});
