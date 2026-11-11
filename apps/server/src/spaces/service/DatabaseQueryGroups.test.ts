import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { databaseError, databaseKit, limitError } from "./Databases.testkit.ts";
import { NAMES, bulkRows, ids, options, seed } from "./DatabaseQuery.testkit.ts";
import { boot, env, fixture } from "./Spaces.testkit.ts";

const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
const titleId = C.SpacePropertyId.make("title");
const [Al, Br, Ch, De, Ec, Fo, Em] = NAMES;

const label = (key: C.SpaceGroupKey): string => {
  switch (key.kind) {
    case "option":
      return String(Reflect.get(key, "optionId"));
    case "status_group":
      return String(Reflect.get(key, "group"));
    case "checkbox":
      return String(Reflect.get(key, "value"));
    case "text":
      return String(Reflect.get(key, "value"));
    case "number_range":
      return `${Reflect.get(key, "start")}..${Reflect.get(key, "end")}`;
    case "date":
      return String(Reflect.get(key, "start"));
    case "page":
      return String(Reflect.get(key, "pageId"));
    default:
      return "empty";
  }
};

type Case = readonly [
  string,
  C.SpaceGroup,
  readonly (readonly [string, number])[],
  Partial<C.SpaceDatabaseQueryInput>?,
];

const cases: readonly Case[] = [
  [
    "select by option, every option and a trailing empty bucket",
    { property: ids.prio },
    [
      [options.low, 2],
      [options.med, 2],
      [options.high, 2],
      ["empty", 1],
    ],
  ],
  [
    "select descending reverses the non-empty buckets only",
    { property: ids.prio, sort: "descending" },
    [
      [options.high, 2],
      [options.med, 2],
      [options.low, 2],
      ["empty", 1],
    ],
  ],
  [
    "status by option",
    { property: ids.state },
    [
      [options.todo, 2],
      [options.prog, 2],
      [options.done, 2],
      ["empty", 1],
    ],
  ],
  [
    "status by group",
    { property: ids.state, by: "status_group" },
    [
      ["todo", 2],
      ["in_progress", 2],
      ["complete", 2],
      ["empty", 1],
    ],
  ],
  [
    "multi_select puts a row in every bucket of its options",
    { property: ids.tags },
    [
      [options.a, 2],
      [options.b, 3],
      [options.c, 3],
      ["empty", 2],
    ],
  ],
  [
    "checkbox has both values and no empty bucket",
    { property: ids.done },
    [
      ["false", 4],
      ["true", 3],
    ],
  ],
  [
    "title exact",
    { property: titleId },
    [
      ["alpha", 1],
      ["bravo", 1],
      ["charlie", 1],
      ["delta", 1],
      ["echo", 1],
      ["foxtrot", 1],
      ["empty", 1],
    ],
  ],
  [
    "title alphabetical",
    { property: titleId, by: "alphabetical" },
    [
      ["a", 1],
      ["b", 1],
      ["c", 1],
      ["d", 1],
      ["e", 1],
      ["f", 1],
      ["empty", 1],
    ],
  ],
  [
    "text exact folds case and accents",
    { property: ids.note },
    [
      ["hello", 2],
      ["hello world", 2],
      ["world", 1],
      ["x", 1],
      ["empty", 1],
    ],
  ],
  [
    "number ranges, including a negative bucket",
    { property: ids.points, by: { range: { start: 0, size: 20 } } },
    [
      ["-20..0", 1],
      ["0..20", 2],
      ["20..40", 3],
      ["empty", 1],
    ],
  ],
  [
    "unique_id ranges",
    { property: ids.number, by: { range: { start: 1, size: 3 } } },
    [
      ["1..4", 3],
      ["4..7", 3],
      ["7..10", 1],
    ],
  ],
  [
    "date by month",
    { property: ids.due, by: "month" },
    [
      ["2026-11-01", 5],
      ["2026-12-01", 1],
      ["empty", 1],
    ],
  ],
  [
    "date by day",
    { property: ids.due, by: "day" },
    [
      ["2026-11-09", 1],
      ["2026-11-10", 1],
      ["2026-11-11", 2],
      ["2026-11-12", 1],
      ["2026-12-25", 1],
      ["empty", 1],
    ],
  ],
  [
    "date by week starting Sunday",
    { property: ids.due, by: "week" },
    [
      ["2026-11-08", 5],
      ["2026-12-20", 1],
      ["empty", 1],
    ],
  ],
  [
    "date by week starting Monday",
    { property: ids.due, by: "week" },
    [
      ["2026-11-09", 5],
      ["2026-12-21", 1],
      ["empty", 1],
    ],
    { weekStart: "monday" },
  ],
  [
    "date by year",
    { property: ids.due, by: "year" },
    [
      ["2026-01-01", 6],
      ["empty", 1],
    ],
  ],
  [
    "date by day in the viewer's zone shifts timed cells only",
    { property: ids.due, by: "day" },
    [
      ["2026-11-09", 1],
      ["2026-11-10", 1],
      ["2026-11-11", 1],
      ["2026-11-12", 2],
      ["2026-12-25", 1],
      ["empty", 1],
    ],
    { timeZone: "Asia/Tokyo" },
  ],
  [
    "created_time by day",
    { property: ids.created, by: "day" },
    [
      ["2026-11-05", 1],
      ["2026-11-06", 1],
      ["2026-11-07", 1],
      ["2026-11-08", 1],
      ["2026-11-09", 1],
      ["2026-11-10", 1],
      ["2026-11-11", 1],
    ],
  ],
];

it.layer(NodeServices.layer)("Spaces database query groups", (it) => {
  it.effect("buckets by every groupable type and continues each bucket through its scope", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, rows } = yield* seed(dbPath);
        for (const [name, group, expected, extra] of cases) {
          const grouped = yield* query({ mode: "groups", group, ...extra });
          assert.deepEqual(
            (grouped.groups ?? []).map((bucket) => [label(bucket.key), bucket.count]),
            expected.map(([key, count]) => [key, count]),
            name,
          );
          // Every bucket's scope returns exactly its rows, and rows reach buckets only through keys.
          for (const bucket of grouped.groups ?? []) {
            const scoped = yield* query({ group, scope: { group: bucket.key }, ...extra });
            assert.equal(scoped.rows.length, bucket.count, `${name}: ${label(bucket.key)}`);
          }
        }
        assert.lengthOf(rows, 7);
      }),
    ),
  );

  it.effect("keeps fractional number ranges consistent between counts and scopes", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, kit, dataSourceId, rows } = yield* seed(dbPath);
        const values = [0.57, 0.6, 5.6, 8.2, 0.1, 0.3, 2.7];
        for (const [index, value] of values.entries())
          yield* kit.setCells(dataSourceId, rows[index]!, { [ids.points]: value });
        const group = { property: ids.points, by: { range: { start: 0, size: 0.1 } } } as const;
        const grouped = yield* query({ mode: "groups", group });
        let counted = 0;
        for (const bucket of grouped.groups ?? []) {
          counted += bucket.count;
          const scoped = yield* query({ group, scope: { group: bucket.key } });
          assert.equal(scoped.rows.length, bucket.count, label(bucket.key));
        }
        assert.equal(counted, 7);
      }),
    ),
  );

  it.effect("labels text and page buckets and orders pages by title", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, project } = yield* seed(dbPath);
        const pages = yield* query({ mode: "groups", group: { property: ids.project } });
        assert.deepEqual(
          (pages.groups ?? []).map((bucket) => [label(bucket.key), bucket.label, bucket.count]),
          [
            [project[0]!, "P1", 2],
            [project[1]!, "P2", 2],
            ["empty", undefined, 4],
          ],
        );
        const text = yield* query({ mode: "groups", group: { property: ids.note } });
        assert.deepEqual(
          (text.groups ?? []).map((bucket) => bucket.label && fold(bucket.label)),
          ["hello", "hello world", "world", "x", undefined],
        );
        const titles = yield* query({ mode: "groups", group: { property: titleId } });
        assert.deepEqual(
          (titles.groups ?? []).map((bucket) => bucket.label),
          [Al, Br, Ch, De, Ec, Fo, undefined],
        );
      }),
    ),
  );

  it.effect("sub-groups every bucket, zero-filling option columns", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query } = yield* seed(dbPath);
        const grouped = yield* query({
          mode: "groups",
          group: { property: ids.prio },
          subGroup: { property: ids.state },
          rowsPerGroup: 5,
        });
        const shape = (grouped.groups ?? []).map((bucket) => [
          label(bucket.key),
          bucket.count,
          bucket.rows.length,
          (bucket.subGroups ?? []).map((sub) => [
            label(sub.key),
            sub.count,
            sub.rows.map((r) => r.page.title),
          ]),
        ]);
        assert.deepEqual(shape, [
          [
            options.low,
            2,
            0,
            [
              [options.todo, 1, [Al]],
              [options.prog, 1, [Ec]],
              [options.done, 0, []],
              ["empty", 0, []],
            ],
          ],
          [
            options.med,
            2,
            0,
            [
              [options.todo, 0, []],
              [options.prog, 1, [Br]],
              [options.done, 1, [Fo]],
              ["empty", 0, []],
            ],
          ],
          [
            options.high,
            2,
            0,
            [
              [options.todo, 0, []],
              [options.prog, 0, []],
              [options.done, 1, [Ch]],
              ["empty", 1, [Em]],
            ],
          ],
          [
            "empty",
            1,
            0,
            [
              [options.todo, 1, [De]],
              [options.prog, 0, []],
              [options.done, 0, []],
              ["empty", 0, []],
            ],
          ],
        ]);
        // A leaf bucket is reachable by scoping both levels.
        const leaf = yield* query({
          group: { property: ids.prio },
          subGroup: { property: ids.state },
          scope: { group: { kind: "option", optionId: options.high }, subGroup: { kind: "empty" } },
        });
        assert.deepEqual(
          leaf.rows.map((row) => row.page.title),
          [Em],
        );
      }),
    ),
  );

  it.effect("previews rows per bucket and hands out a cursor that finishes the bucket", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, titles } = yield* seed(dbPath);
        const group = { property: ids.prio };
        const sorts: C.SpaceSort[] = [{ property: ids.points, direction: "descending" }];
        const grouped = yield* query({ mode: "groups", group, sorts, rowsPerGroup: 1 });
        const buckets = grouped.groups ?? [];
        assert.deepEqual(
          buckets.map((bucket) => bucket.rows.map((r) => r.page.title)),
          [[Ec], [Br], [Ch], [De]],
        );
        assert.deepEqual(
          buckets.map((bucket) => bucket.nextCursor !== null),
          [true, true, true, false],
        );
        const rest = yield* query({
          group,
          sorts,
          scope: { group: buckets[0]!.key },
          cursor: buckets[0]!.nextCursor!,
        });
        assert.deepEqual(titles(rest), [Al]);
        assert.isNull(rest.nextCursor);
        const failure = yield* Effect.flip(
          query({
            group,
            sorts,
            scope: { group: buckets[1]!.key },
            cursor: buckets[0]!.nextCursor!,
          }),
        );
        assert.equal(failure._tag, "SpaceCursorStaleError");
      }),
    ),
  );

  it.effect("shares at most maxQueryRows previews among many buckets", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query } = yield* seed(dbPath);
        // Seven title buckets with 25 rows each would be 175 rows; the previews are thinned to fit.
        const grouped = yield* query({
          mode: "groups",
          group: { property: titleId },
          rowsPerGroup: 25,
        });
        const shown = (grouped.groups ?? []).reduce(
          (total, bucket) => total + bucket.rows.length,
          0,
        );
        assert.isAtMost(shown, 100);
        assert.equal(shown, 7);
      }),
    ),
  );

  it.effect("truncates past maxGroupBuckets and rejects groupings it cannot run", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, dataSourceId, spaceId } = yield* seed(dbPath);
        const reason = (extra: Partial<C.SpaceDatabaseQueryInput>) =>
          Effect.map(databaseError(query(extra)), (error) => error.reason);
        assert.equal(
          yield* reason({ mode: "groups", group: { property: ids.files } }),
          "invalid_group",
        );
        assert.equal(
          yield* reason({ mode: "groups", group: { property: ids.calc } }),
          "property_not_queryable",
        );
        assert.equal(
          yield* reason({ mode: "groups", group: { property: ids.due, by: "relative" } }),
          "unsupported",
        );
        assert.equal(
          yield* reason({ mode: "groups", group: { property: ids.prio, by: "day" } }),
          "invalid_group",
        );
        assert.equal(
          yield* reason({ mode: "groups", group: { property: ids.points } }),
          "invalid_group",
        );
        assert.equal(
          yield* reason({
            mode: "groups",
            group: { property: ids.prio },
            subGroup: { property: ids.prio },
          }),
          "invalid_group",
        );
        assert.equal(yield* reason({ mode: "groups" }), "invalid_group");
        assert.equal(
          yield* reason({
            group: { property: ids.prio },
            scope: { group: { kind: "checkbox", value: true } },
          }),
          "invalid_scope",
        );
        assert.equal(yield* reason({ scope: { group: { kind: "empty" } } }), "invalid_scope");
        assert.equal(yield* reason({ scope: { parentRowId: null } }), "invalid_scope");
        assert.equal(
          yield* limitError(
            query({ mode: "groups", group: { property: ids.prio }, rowsPerGroup: 26 }),
          ),
          "databases.maxGroupPreviewRows",
        );
        // 250 distinct titles: only the first 200 buckets come back.
        yield* bulkRows({ dbPath, dataSourceId, spaceId, count: 250, prefix: "Many" });
        const wide = yield* query({ mode: "groups", group: { property: titleId } });
        assert.lengthOf(wide.groups ?? [], 200);
        assert.isTrue(wide.groupsTruncated);
        assert.equal(label(wide.groups![0]!.key), "alpha");
        const narrow = yield* query({ mode: "groups", group: { property: ids.prio } });
        assert.isUndefined(narrow.groupsTruncated);
      }),
    ),
  );

  it.effect(
    "scopes to top-level rows or the children of one row through the sub-items property",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const kit = databaseKit(service, common, page.spaceId);
          const created = yield* kit.create("Tree", { appendToPageId: page.id });
          const source = created.dataSourceId;
          const [top, kid, other] = (yield* kit.addRows(source, [
            { title: "top" },
            { title: "kid" },
            { title: "other" },
          ])).rows.map((row) => row.pageId);
          const parent = (yield* kit.schema(source, [
            {
              op: "addProperty",
              property: {
                name: "Parent",
                type: "relation",
                config: { dataSourceId: source, limit: "one", twoWay: { propertyId: "kids01" } },
              },
            },
          ])).created[0]!.propertyId!;
          yield* service.updateDataSource({
            ...common,
            mutationId: "sub",
            dataSourceId: source,
            subItems: { parentPropertyId: parent },
          });
          yield* kit.setCells(source, kid!, { [parent]: [top!] });
          const query = (scope: object) =>
            service.queryDatabase({
              ...env,
              dataSourceId: source,
              mode: "rows",
              timeZone: "UTC",
              scope,
            });
          const titles = (r: C.SpaceDatabaseQueryResult) => r.rows.map((row) => row.page.title);
          assert.deepEqual(titles(yield* query({ parentRowId: null })), ["top", "other"]);
          assert.deepEqual(titles(yield* query({ parentRowId: top! })), ["kid"]);
          assert.deepEqual(titles(yield* query({ parentRowId: other! })), []);
        }),
      ),
  );
});
