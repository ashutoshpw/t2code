import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import * as TestClock from "effect/testing/TestClock";

import { boot, env, fixture, recoveryIntent } from "./Spaces.testkit.ts";
import { databaseError, databaseKit, limitError } from "./Databases.testkit.ts";
import { NAMES, cond, ids, options, seed } from "./DatabaseQuery.testkit.ts";

const [Al, Br, Ch, De, Ec, Fo, Em] = NAMES;
const titleId = C.SpacePropertyId.make("title");
const todayRel = { relative: "today" };

type Row = readonly [string, C.SpaceFilter, readonly string[]];

const textRows: readonly Row[] = [
  ["title equals folds case", cond(titleId, "equals", "ALPHA"), [Al]],
  ["title does_not_equal", cond(titleId, "does_not_equal", "alpha"), [Br, Ch, De, Ec, Fo, Em]],
  ["title contains", cond(titleId, "contains", "L"), [Al, Ch, De]],
  ["title does_not_contain", cond(titleId, "does_not_contain", "l"), [Br, Ec, Fo, Em]],
  ["title starts_with", cond(titleId, "starts_with", "CH"), [Ch]],
  ["title ends_with", cond(titleId, "ends_with", "o"), [Br, Ec]],
  ["title is_empty", cond(titleId, "is_empty"), [Em]],
  ["title is_not_empty", cond(titleId, "is_not_empty"), [Al, Br, Ch, De, Ec, Fo]],
  ["title equals empty string is_empty", cond(titleId, "equals", ""), [Em]],
  [
    "title does_not_equal empty string",
    cond(titleId, "does_not_equal", ""),
    [Al, Br, Ch, De, Ec, Fo],
  ],
  ["title contains empty string matches all", cond(titleId, "contains", ""), NAMES],
  ["title starts_with empty string matches all", cond(titleId, "starts_with", ""), NAMES],
  ["title ends_with empty string matches all", cond(titleId, "ends_with", ""), NAMES],
  ["title does_not_contain empty string matches none", cond(titleId, "does_not_contain", ""), []],
  ["text equals ignores case and accents", cond(ids.note, "equals", "hello"), [Br, Fo]],
  ["text contains ignores accents", cond(ids.note, "contains", "hello"), [Al, Br, De, Fo]],
  ["text contains", cond(ids.note, "contains", "WORLD"), [Al, De, Ec]],
  ["text starts_with", cond(ids.note, "starts_with", "hello"), [Al, Br, De, Fo]],
  ["text ends_with", cond(ids.note, "ends_with", "world"), [Al, De, Ec]],
  ["text does_not_equal", cond(ids.note, "does_not_equal", "hello"), [Al, Ch, De, Ec, Em]],
  [
    "text does_not_contain includes empty",
    cond(ids.note, "does_not_contain", "hello"),
    [Ch, Ec, Em],
  ],
  ["text is_empty", cond(ids.note, "is_empty"), [Ch]],
  ["text is_not_empty", cond(ids.note, "is_not_empty"), [Al, Br, De, Ec, Fo, Em]],
  ["url equals", cond(ids.link, "equals", "https://A.example"), [Al]],
  ["url contains", cond(ids.link, "contains", "example"), [Al, Br, Ec, Fo]],
  ["url ends_with", cond(ids.link, "ends_with", "/path"), [Ec]],
  ["url is_empty", cond(ids.link, "is_empty"), [Ch, De, Em]],
];

const numberRows: readonly Row[] = [
  ["number equals", cond(ids.points, "equals", 20), [Br, Ec]],
  ["number equals zero", cond(ids.points, "equals", 0), [Em]],
  [
    "number does_not_equal includes empty",
    cond(ids.points, "does_not_equal", 20),
    [Al, Ch, De, Fo, Em],
  ],
  ["number greater_than", cond(ids.points, "greater_than", 10), [Br, Ch, Ec]],
  ["number less_than", cond(ids.points, "less_than", 10), [Fo, Em]],
  [
    "number greater_than_or_equal_to",
    cond(ids.points, "greater_than_or_equal_to", 20),
    [Br, Ch, Ec],
  ],
  ["number less_than_or_equal_to", cond(ids.points, "less_than_or_equal_to", 10), [Al, Fo, Em]],
  ["number is_empty", cond(ids.points, "is_empty"), [De]],
  ["number is_not_empty", cond(ids.points, "is_not_empty"), [Al, Br, Ch, Ec, Fo, Em]],
  ["unique_id equals", cond(ids.number, "equals", 3), [Ch]],
  ["unique_id does_not_equal", cond(ids.number, "does_not_equal", 3), [Al, Br, De, Ec, Fo, Em]],
  ["unique_id greater_than", cond(ids.number, "greater_than", 5), [Fo, Em]],
  ["unique_id less_than_or_equal_to", cond(ids.number, "less_than_or_equal_to", 2), [Al, Br]],
  ["checkbox equals true", cond(ids.done, "equals", true), [Al, Ch, Fo]],
  [
    "checkbox equals false counts a missing cell",
    cond(ids.done, "equals", false),
    [Br, De, Ec, Em],
  ],
  ["checkbox does_not_equal true", cond(ids.done, "does_not_equal", true), [Br, De, Ec, Em]],
  ["checkbox does_not_equal false", cond(ids.done, "does_not_equal", false), [Al, Ch, Fo]],
];

const optionRows: readonly Row[] = [
  ["select equals", cond(ids.prio, "equals", options.low), [Al, Ec]],
  ["select does_not_equal", cond(ids.prio, "does_not_equal", options.low), [Br, Ch, De, Fo, Em]],
  ["select is_empty", cond(ids.prio, "is_empty"), [De]],
  ["select is_not_empty", cond(ids.prio, "is_not_empty"), [Al, Br, Ch, Ec, Fo, Em]],
  ["status equals", cond(ids.state, "equals", options.prog), [Br, Ec]],
  ["status does_not_equal", cond(ids.state, "does_not_equal", options.prog), [Al, Ch, De, Fo, Em]],
  ["status in_group", cond(ids.state, "in_group", "todo"), [Al, De]],
  ["status in_group complete", cond(ids.state, "in_group", "complete"), [Ch, Fo]],
  [
    "status not_in_group includes empty",
    cond(ids.state, "not_in_group", "todo"),
    [Br, Ch, Ec, Fo, Em],
  ],
  ["status is_empty", cond(ids.state, "is_empty"), [Em]],
  ["status is_not_empty", cond(ids.state, "is_not_empty"), [Al, Br, Ch, De, Ec, Fo]],
  ["multi_select contains", cond(ids.tags, "contains", options.a), [Al, De]],
  ["multi_select contains b", cond(ids.tags, "contains", options.b), [Al, Br, De]],
  [
    "multi_select does_not_contain",
    cond(ids.tags, "does_not_contain", options.a),
    [Br, Ch, Ec, Fo, Em],
  ],
  ["multi_select is_empty", cond(ids.tags, "is_empty"), [Ch, Fo]],
  ["multi_select is_not_empty", cond(ids.tags, "is_not_empty"), [Al, Br, De, Ec, Em]],
  ["files is_empty", cond(ids.files, "is_empty"), [Br, De, Ec, Fo, Em]],
  ["files is_not_empty", cond(ids.files, "is_not_empty"), [Al, Ch]],
];

// "Now" is 2026-11-11 12:00 UTC, a Wednesday.
const dateRows: readonly Row[] = [
  ["date equals a day, date-only and timed cells", cond(ids.due, "equals", "2026-11-11"), [Br, Ec]],
  ["date before a day", cond(ids.due, "before", "2026-11-11"), [Al, De]],
  ["date after a day", cond(ids.due, "after", "2026-11-11"), [Ch, Em]],
  ["date on_or_before a day", cond(ids.due, "on_or_before", "2026-11-11"), [Al, Br, De, Ec]],
  ["date on_or_after a day", cond(ids.due, "on_or_after", "2026-11-11"), [Br, Ch, Ec, Em]],
  ["date part end equals", cond(ids.due, "equals", "2026-11-13", "end"), [De]],
  ["date part end on_or_after", cond(ids.due, "on_or_after", "2026-11-12", "end"), [Ch, De, Em]],
  ["date equals an instant", cond(ids.due, "equals", "2026-11-12T09:00:00Z"), [Ch]],
  ["date before an instant", cond(ids.due, "before", "2026-11-11T23:30:00Z"), [Al, De]],
  ["date after an instant", cond(ids.due, "after", "2026-11-11T23:30:00Z"), [Ch, Em]],
  [
    "date on_or_before an instant",
    cond(ids.due, "on_or_before", "2026-11-11T23:30:00Z"),
    [Al, Br, De, Ec],
  ],
  [
    "date on_or_after an instant",
    cond(ids.due, "on_or_after", "2026-11-11T23:30:00Z"),
    [Br, Ch, Ec, Em],
  ],
  ["date relative today", cond(ids.due, "equals", todayRel), [Br, Ec]],
  ["date relative tomorrow", cond(ids.due, "equals", { relative: "tomorrow" }), [Ch]],
  ["date relative yesterday", cond(ids.due, "equals", { relative: "yesterday" }), [Al]],
  ["date relative one_week_ago", cond(ids.due, "equals", { relative: "one_week_ago" }), []],
  [
    "date relative one_week_from_now",
    cond(ids.due, "before", { relative: "one_week_from_now" }),
    [Al, Br, Ch, De, Ec],
  ],
  [
    "date relative one_month_ago",
    cond(ids.due, "after", { relative: "one_month_ago" }),
    [Al, Br, Ch, De, Ec, Em],
  ],
  [
    "date relative one_month_from_now",
    cond(ids.due, "on_or_after", { relative: "one_month_from_now" }),
    [Em],
  ],
  [
    "date within past week",
    cond(ids.due, "within", { direction: "past", unit: "week" }),
    [Al, Br, De, Ec],
  ],
  [
    "date within next week",
    cond(ids.due, "within", { direction: "next", unit: "week" }),
    [Br, Ch, Ec],
  ],
  [
    "date within this week",
    cond(ids.due, "within", { direction: "this", unit: "week" }),
    [Al, Br, Ch, De, Ec],
  ],
  [
    "date within this month",
    cond(ids.due, "within", { direction: "this", unit: "month" }),
    [Al, Br, Ch, De, Ec],
  ],
  [
    "date within this year",
    cond(ids.due, "within", { direction: "this", unit: "year" }),
    [Al, Br, Ch, De, Ec, Em],
  ],
  [
    "date within past 2 days",
    cond(ids.due, "within", { direction: "past", unit: "day", count: 2 }),
    [Al, Br, De, Ec],
  ],
  ["date within this day", cond(ids.due, "within", { direction: "this", unit: "day" }), [Br, Ec]],
  ["date is_empty", cond(ids.due, "is_empty"), [Fo]],
  ["date is_not_empty", cond(ids.due, "is_not_empty"), [Al, Br, Ch, De, Ec, Em]],
  ["created_time equals a day", cond(ids.created, "equals", "2026-11-07"), [Ch]],
  ["created_time before an instant", cond(ids.created, "before", "2026-11-07T10:00:00Z"), [Al, Br]],
  [
    "created_time on_or_before an instant",
    cond(ids.created, "on_or_before", "2026-11-07T10:00:00Z"),
    [Al, Br, Ch],
  ],
  ["created_time after a day", cond(ids.created, "after", "2026-11-09"), [Fo, Em]],
  [
    "created_time within past 2 days",
    cond(ids.created, "within", { direction: "past", unit: "day", count: 2 }),
    [Ec, Fo, Em],
  ],
  [
    "last_edited_time follows an edit",
    cond(ids.edited, "on_or_after", "2026-11-11T11:00:00Z"),
    [Br],
  ],
  ["last_edited_time equals today", cond(ids.edited, "equals", todayRel), [Br, Em]],
];

const tables: readonly (readonly [string, readonly Row[]])[] = [
  ["text, url and title", textRows],
  ["number, unique_id and checkbox", numberRows],
  ["select, status, multi_select and files", optionRows],
  ["date, created_time and last_edited_time", dateRows],
];

it.layer(NodeServices.layer)("Spaces database query filters", (it) => {
  it.effect.each(tables)("matches every operator of %s", ([, rows]) =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, titles } = yield* seed(dbPath);
        for (const [label, filter, expected] of rows) {
          const result = yield* Effect.mapError(
            query({ filter }),
            (error) => `${label}: ${JSON.stringify(error)}`,
          );
          assert.deepEqual(titles(result), [...expected], label);
        }
      }),
    ),
  );

  it.effect("filters relations through live targets only", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, titles, project, service, common } = yield* seed(dbPath);
        const [Al, Br, Ch, De, Ec, Fo, Em] = NAMES;
        const rel = (operator: string, value?: string) => cond(ids.project, operator, value);
        assert.deepEqual(titles(yield* query({ filter: rel("contains", project[0]!) })), [Al, Br]);
        assert.deepEqual(titles(yield* query({ filter: rel("does_not_contain", project[0]!) })), [
          Ch,
          De,
          Ec,
          Fo,
          Em,
        ]);
        assert.deepEqual(titles(yield* query({ filter: rel("is_empty") })), [Ch, De, Fo, Em]);
        assert.deepEqual(titles(yield* query({ filter: rel("is_not_empty") })), [Al, Br, Ec]);
        // A target in the trash is not a target: a cell holding only trashed targets reads as empty.
        yield* service.trashPage(
          yield* recoveryIntent(service, common, project[1]!, "trash", "trash-p2"),
        );
        assert.deepEqual(titles(yield* query({ filter: rel("contains", project[1]!) })), []);
        assert.deepEqual(titles(yield* query({ filter: rel("is_empty") })), [Ch, De, Ec, Fo, Em]);
        assert.deepEqual(titles(yield* query({ filter: rel("is_not_empty") })), [Al, Br]);
      }),
    ),
  );

  it.effect("resolves relative dates in the viewer's zone and week", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, titles } = yield* seed(dbPath);
        const [Al, Br, Ch, , Ec] = NAMES;
        // 12:00 UTC on the 11th is 21:00 in Tokyo, still the 11th; the timed cells shift a day.
        const tokyo = { timeZone: "Asia/Tokyo" };
        assert.deepEqual(
          titles(yield* query({ ...tokyo, filter: cond(ids.due, "equals", todayRel) })),
          [Br],
        );
        assert.deepEqual(
          titles(
            yield* query({ ...tokyo, filter: cond(ids.due, "equals", { relative: "tomorrow" }) }),
          ),
          [Ch, Ec],
        );
        assert.deepEqual(
          titles(yield* query({ ...tokyo, filter: cond(ids.created, "equals", "2026-11-05") })),
          [Al],
        );
        // New York is five hours behind; created_time compares instants against the zone's day.
        assert.deepEqual(
          titles(
            yield* query({
              timeZone: "America/New_York",
              filter: cond(ids.created, "equals", "2026-11-06"),
            }),
          ),
          [Br],
        );
        const bad = yield* databaseError(
          query({ timeZone: "Mars/Olympus", filter: cond(ids.due, "equals", todayRel) }),
        );
        assert.equal(bad.reason, "invalid_time_zone");
      }),
    ),
  );

  it.effect("clamps month arithmetic and starts the week on the requested day", () =>
    fixture(() =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-03-31T12:00:00.000Z"));
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Dates", {
          appendToPageId: page.id,
          properties: [{ id: ids.due, name: "When", type: "date" }],
        });
        const days = ["2026-02-27", "2026-02-28", "2026-03-01", "2026-04-30", "2026-05-01"];
        yield* kit.addRows(
          created.dataSourceId,
          days.map((day) => ({ title: day, cells: { [ids.due]: { start: day } } })),
        );
        const query = (extra: object) =>
          service.queryDatabase({
            ...env,
            dataSourceId: created.dataSourceId,
            mode: "rows",
            timeZone: "UTC",
            ...extra,
          });
        const titles = (r: C.SpaceDatabaseQueryResult) => r.rows.map((row) => row.page.title);
        // One month before March 31 is February 28; one month after is April 30.
        assert.deepEqual(
          titles(yield* query({ filter: cond(ids.due, "equals", { relative: "one_month_ago" }) })),
          ["2026-02-28"],
        );
        assert.deepEqual(
          titles(
            yield* query({ filter: cond(ids.due, "equals", { relative: "one_month_from_now" }) }),
          ),
          ["2026-04-30"],
        );
        assert.deepEqual(
          titles(
            yield* query({ filter: cond(ids.due, "within", { direction: "past", unit: "month" }) }),
          ),
          ["2026-02-28", "2026-03-01"],
        );
      }),
    ),
  );

  it.effect("starts 'this week' on Sunday or Monday", () =>
    fixture(() =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-08T12:00:00.000Z"));
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Dates", {
          appendToPageId: page.id,
          properties: [{ id: ids.due, name: "When", type: "date" }],
        });
        const days = ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-14", "2026-11-15"];
        yield* kit.addRows(
          created.dataSourceId,
          days.map((day) => ({ title: day, cells: { [ids.due]: { start: day } } })),
        );
        const query = (weekStart: "sunday" | "monday") =>
          service.queryDatabase({
            ...env,
            dataSourceId: created.dataSourceId,
            mode: "rows",
            timeZone: "UTC",
            weekStart,
            filter: cond(ids.due, "within", { direction: "this", unit: "week" }),
          });
        const titles = (r: C.SpaceDatabaseQueryResult) => r.rows.map((row) => row.page.title);
        assert.deepEqual(titles(yield* query("sunday")), [
          "2026-11-08",
          "2026-11-09",
          "2026-11-14",
        ]);
        assert.deepEqual(titles(yield* query("monday")), ["2026-11-07", "2026-11-08"]);
      }),
    ),
  );

  it.effect(
    "evaluates nested and/or groups up to the depth limit and rejects what cannot run",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { query, titles } = yield* seed(dbPath);
          const [Al, Br, Ch, De, Ec, Fo, Em] = NAMES;
          const low = cond(ids.prio, "equals", options.low);
          const big = cond(ids.points, "greater_than", 15);
          const done = cond(ids.done, "equals", true);
          // Depth 3: and > or > and > condition.
          const nested: C.SpaceFilter = {
            and: [{ or: [{ and: [low, done] }, big] }, cond(titleId, "is_not_empty")],
          };
          assert.deepEqual(titles(yield* query({ filter: nested })), [Al, Br, Ch, Ec]);
          assert.deepEqual(titles(yield* query({ filter: { and: [] } })), [...NAMES]);
          assert.deepEqual(titles(yield* query({ filter: { or: [] } })), []);
          assert.deepEqual(titles(yield* query({ filter: { or: [{ and: [] }, low] } })), [
            ...NAMES,
          ]);
          assert.deepEqual(titles(yield* query({ filter: { and: [{ or: [] }, low] } })), []);
          // An extra filter and a search are ANDed with the base filter.
          assert.deepEqual(titles(yield* query({ filter: big, extraFilter: done })), [Ch]);
          assert.deepEqual(titles(yield* query({ filter: big, search: "ECHO" })), [Ec]);
          assert.deepEqual(titles(yield* query({ filter: null, search: "o" })), [Br, Ec, Fo]);
          // Depth 4 and 51 conditions exceed the limits.
          const deep: C.SpaceFilter = { and: [{ and: [{ and: [{ and: [low] }] }] }] };
          assert.equal(yield* limitError(query({ filter: deep })), "databases.maxFilterDepth");
          const many: C.SpaceFilter = { or: Array.from({ length: 51 }, () => low) };
          assert.equal(yield* limitError(query({ filter: many })), "databases.maxFilterConditions");
          assert.equal(Em, "");
          assert.isDefined(De);
        }),
      ),
  );

  it.effect("rejects formula and rollup, illegal operators and bad values with typed errors", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query } = yield* seed(dbPath);
        const reason = (filter: C.SpaceFilter) =>
          Effect.map(databaseError(query({ filter })), (error) => [error.reason, error.propertyId]);
        assert.deepEqual(yield* reason(cond(ids.calc, "equals", 1)), [
          "property_not_queryable",
          ids.calc,
        ]);
        assert.deepEqual(yield* reason({ and: [cond(ids.calc, "is_empty")] }), [
          "property_not_queryable",
          ids.calc,
        ]);
        assert.deepEqual(yield* reason(cond(ids.done, "contains", true)), [
          "operator_not_supported",
          ids.done,
        ]);
        assert.deepEqual(yield* reason(cond(ids.points, "equals", "ten")), [
          "invalid_filter",
          ids.points,
        ]);
        assert.deepEqual(yield* reason(cond(ids.prio, "equals", "nope1")), [
          "unknown_option",
          ids.prio,
        ]);
        assert.deepEqual(yield* reason(cond(ids.due, "equals", "yesterday-ish")), [
          "invalid_filter",
          ids.due,
        ]);
        assert.deepEqual(yield* reason(cond(ids.points, "frobnicate", 1)), [
          "invalid_filter",
          undefined,
        ]);
        const missing = yield* Effect.flip(
          query({ filter: cond(C.SpacePropertyId.make("gone01"), "is_empty") }),
        );
        assert.equal(missing._tag, "SpaceNotFoundError");
        const sort = yield* databaseError(
          query({ sorts: [{ property: ids.calc, direction: "ascending" }] }),
        );
        assert.equal(sort.reason, "property_not_queryable");
      }),
    ),
  );
});
