import { assert, it } from "@effect/vitest";
import { SPACE_PAGE_SHARE_FORM_ROUTE } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import {
  SECRET,
  httpHarness,
  ids,
  layerTest,
  options,
  reason,
  sharedDatabase,
} from "./PageShareDatabases.testkit.ts";
import { decodeForm, extraIds, sharedForm } from "./PageShareForms.testkit.ts";

type Form = Effect.Success<ReturnType<typeof sharedForm>>;

const submission = (
  f: Form,
  answers: Record<string, unknown>,
  submissionId = "sub-0123456789abcdef",
) => ({
  block: f.blockId,
  view: f.formId,
  submissionId,
  answers,
});
const json = (response: Response) =>
  Effect.promise(() => response.json() as Promise<Record<string, unknown>>);
const query = (f: Form) =>
  f.spaces.queryDatabase({
    environmentId: f.common.environmentId,
    dataSourceId: f.dataSourceId,
    mode: "rows",
    timeZone: "UTC",
  });
const receiptCount = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      readonly n: number;
    }>`SELECT COUNT(*) AS n FROM spaces_receipts WHERE mutation_id LIKE 'form_%'`;
    return Number(row!.n);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
});

it.effect("serves a form's questions and nothing else of the database", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* sharedForm();
      const { get } = yield* httpHarness();
      const response = yield* get(
        SPACE_PAGE_SHARE_FORM_ROUTE,
        { block: f.blockId, view: f.formId },
        f.token,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const text = yield* Effect.promise(() => response.clone().text());
      const form = yield* decodeForm(yield* json(response));
      assert.deepEqual(
        form.questions.map((question) => [question.propertyId, question.type, question.required]),
        [
          ["title", "title", true],
          [ids.status, "select", false],
          [ids.note, "text", false],
          [ids.points, "number", false],
        ],
      );
      assert.equal(form.title, "Form");
      assert.equal(form.description, "Tell us");
      assert.equal(form.questions[2]!.label, "Your note");
      assert.deepEqual(
        form.questions[1]!.options!.map((option) => option.name),
        ["Alpha", "Bravo", "Charlie"],
      );
      for (const leak of [ids.secret, extraIds.relation, SECRET, "Row one", "filter", ids.files])
        assert.notInclude(text, leak);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("is closed while responses are off and ends with the link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* sharedForm({ accept: false });
      const { get, postJson } = yield* httpHarness();
      const params = { block: f.blockId, view: f.formId };
      const probe = (token: string) =>
        Effect.gen(function* () {
          const read = yield* get(SPACE_PAGE_SHARE_FORM_ROUTE, params, token);
          const write = yield* postJson(
            SPACE_PAGE_SHARE_FORM_ROUTE,
            submission(f, { title: "t" }),
            token,
          );
          return [
            read.status,
            (yield* json(read)).reason,
            write.status,
            (yield* json(write)).reason,
          ];
        });
      assert.deepEqual(yield* probe(f.token), [403, "closed", 403, "closed"]);
      yield* f.shares.setResponses({ pageId: f.host, acceptResponses: true });
      assert.equal((yield* probe(f.token))[0], 200);
      const replaced = (yield* f.shares.create({ pageId: f.host })).url.split("#")[1]!;
      assert.deepEqual(yield* probe(f.token), [403, "inactive", 403, "inactive"]);
      assert.equal((yield* probe(replaced))[0], 200);
      yield* f.shares.stop({ pageId: f.host });
      assert.deepEqual(yield* probe(replaced), [403, "inactive", 403, "inactive"]);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("ends when the page is trashed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* sharedForm();
      const { postJson } = yield* httpHarness();
      yield* f.recover(f.host, "trash");
      const write = yield* postJson(
        SPACE_PAGE_SHARE_FORM_ROUTE,
        submission(f, { title: "t" }),
        f.token,
      );
      assert.deepEqual([write.status, (yield* json(write)).reason], [403, "inactive"]);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("writes one row through a receipt, answers received, and ignores a repeat", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* sharedForm();
      const { postJson } = yield* httpHarness();
      const answers = {
        title: " Hello ",
        [ids.status]: options.b,
        [ids.note]: "hi",
        [ids.points]: 5,
      };
      const first = yield* postJson(SPACE_PAGE_SHARE_FORM_ROUTE, submission(f, answers), f.token);
      assert.equal(first.status, 200);
      assert.deepEqual(yield* json(first), { status: "received" });
      const again = yield* postJson(SPACE_PAGE_SHARE_FORM_ROUTE, submission(f, answers), f.token);
      assert.deepEqual(yield* json(again), { status: "received" });
      const rows = (yield* query(f)).rows;
      assert.lengthOf(rows, 4);
      const created = rows.find((row) => row.page.title === "Hello")!;
      assert.deepEqual(created.cells, {
        title: "Hello",
        [ids.status]: options.b,
        [ids.note]: [{ text: "hi", marks: [] }],
        [ids.points]: 5,
      });
      assert.equal(yield* receiptCount, 1);
      // The same id with other answers is a repeat too, not a second row.
      yield* postJson(SPACE_PAGE_SHARE_FORM_ROUTE, submission(f, { title: "Other" }), f.token);
      assert.lengthOf((yield* query(f)).rows, 4);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("refuses answers outside the form with 422 and writes nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* sharedForm();
      const { postJson } = yield* httpHarness();
      const cases: ReadonlyArray<readonly [Record<string, unknown>, string, string | undefined]> = [
        [{ title: "t", extra: "x" }, "unknown_question", undefined],
        [{ title: "t", [ids.secret]: "x" }, "unknown_question", undefined],
        [{ title: "t", [extraIds.relation]: [] }, "unknown_question", undefined],
        [{ title: "t", [ids.status]: "nope" }, "unknown_option", ids.status],
        [{ title: "t", [ids.note]: "x".repeat(2001) }, "too_long", ids.note],
        [{ [ids.note]: "n" }, "required", "title"],
      ];
      for (const [answers, problem, propertyId] of cases) {
        // Every attempt counts against the link's rate limit, so each case gets a fresh link.
        const token = (yield* f.shares.create({ pageId: f.host })).url.split("#")[1]!;
        const response = yield* postJson(
          SPACE_PAGE_SHARE_FORM_ROUTE,
          submission(f, answers),
          token,
        );
        assert.equal(response.status, 422);
        const body = yield* json(response);
        assert.equal(body.problem, problem);
        assert.equal(body.propertyId, propertyId);
        assert.equal(body.message, "Check your answers and try again.");
      }
      assert.lengthOf((yield* query(f)).rows, 3);
      assert.equal(yield* receiptCount, 0);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("refuses an oversized body, an extra key and a query credential", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* sharedForm();
      const { postJson } = yield* httpHarness();
      const big = yield* postJson(SPACE_PAGE_SHARE_FORM_ROUTE, null, f.token, {
        raw: JSON.stringify(submission(f, { title: "x".repeat(17_000) })),
      });
      assert.equal(big.status, 413);
      const extra = yield* postJson(
        SPACE_PAGE_SHARE_FORM_ROUTE,
        { ...submission(f, { title: "t" }), more: 1 },
        f.token,
      );
      assert.equal(extra.status, 400);
      const query_ = yield* postJson(
        SPACE_PAGE_SHARE_FORM_ROUTE,
        submission(f, { title: "t" }),
        undefined,
        {
          params: { share: f.token },
        },
      );
      assert.equal(query_.status, 400);
      const broken = yield* postJson(SPACE_PAGE_SHARE_FORM_ROUTE, null, f.token, { raw: "{" });
      assert.equal(broken.status, 400);
      assert.lengthOf((yield* query(f)).rows, 3);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("limits submissions per link and starts over after the window", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* sharedForm();
      const { postJson } = yield* httpHarness();
      const send = (token: string, id: string) =>
        postJson(
          SPACE_PAGE_SHARE_FORM_ROUTE,
          submission(f, { title: id }, `sub-${id}-0123456789abcdef`),
          token,
        );
      const statuses = [];
      for (let index = 0; index < 6; index++)
        statuses.push((yield* send(f.token, `a${index}`)).status);
      assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
      const limited = yield* send(f.token, "a6");
      assert.equal((yield* json(limited)).reason, "busy");
      // A new link is a new counter.
      const fresh = (yield* f.shares.create({ pageId: f.host })).url.split("#")[1]!;
      assert.equal((yield* send(fresh, "b0")).status, 200);
      yield* TestClock.adjust(Duration.seconds(61));
      assert.equal((yield* send(fresh, "b1")).status, 200);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("never reads rows through a form view", () =>
  Effect.gen(function* () {
    const f = yield* sharedForm();
    const asset = yield* f.uploadImage("pic");
    yield* f.attachImage(f.rowIds[0]!, "img-one", asset);
    const base = f.request({ viewId: f.formId });
    const attempts = [
      reason(f.shares.databaseQuery(f.token, base)),
      reason(f.shares.databaseRow(f.token, { ...base, rowId: f.rowIds[0]! })),
      reason(f.shares.asset(f.token, undefined, asset, { ...base, rowId: f.rowIds[0]! })),
    ];
    assert.deepEqual(yield* Effect.all(attempts), ["unavailable", "unavailable", "unavailable"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("treats another view or a block outside the tree as unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* sharedForm();
      const outside = yield* f.rootPage("Outside");
      const away = yield* f.kit.create("Away", { appendToPageId: outside });
      const stray = yield* f.spaces.createView({
        ...f.common,
        mutationId: "stray-form",
        dataSourceId: away.dataSourceId,
        name: "Stray",
        type: "form",
        beforeViewId: null,
        layout: { questions: [] },
        block: { pageId: outside, blockId: away.block!.blockId },
      });
      const { get, postJson } = yield* httpHarness();
      for (const [block, view] of [
        [f.blockId, f.viewId],
        [away.block!.blockId, stray.viewId],
      ] as const) {
        const read = yield* get(SPACE_PAGE_SHARE_FORM_ROUTE, { block, view }, f.token);
        assert.deepEqual([read.status, (yield* json(read)).reason], [403, "unavailable"]);
        const write = yield* postJson(
          SPACE_PAGE_SHARE_FORM_ROUTE,
          { ...submission(f, { title: "t" }), block, view },
          f.token,
        );
        assert.deepEqual([write.status, (yield* json(write)).reason], [403, "unavailable"]);
      }
      assert.lengthOf((yield* query(f)).rows, 3);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect(
  "switches responses per page, keeps them across a new link and stops the next submission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* sharedForm({ accept: false });
        assert.isUndefined((yield* f.shares.get({ pageId: f.host })).link!.share.acceptResponses);
        yield* f.shares.setResponses({ pageId: f.host, acceptResponses: true });
        assert.isTrue((yield* f.shares.get({ pageId: f.host })).link!.share.acceptResponses);
        yield* f.shares.create({ pageId: f.host });
        assert.isTrue((yield* f.shares.get({ pageId: f.host })).link!.share.acceptResponses);
        const token = (yield* f.shares.get({ pageId: f.host })).link!.url.split("#")[1]!;
        const { postJson } = yield* httpHarness();
        yield* f.shares.setResponses({ pageId: f.host, acceptResponses: false });
        const write = yield* postJson(
          SPACE_PAGE_SHARE_FORM_ROUTE,
          submission(f, { title: "t" }),
          token,
        );
        assert.deepEqual([write.status, (yield* json(write)).reason], [403, "closed"]);
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.effect("refuses to switch responses for a page without a link", () =>
  Effect.gen(function* () {
    const none = yield* sharedDatabase({ shareHost: false });
    assert.equal(
      yield* reason(none.shares.setResponses({ pageId: none.host, acceptResponses: true })),
      "page_unavailable",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("shares a chart as grouped counts and the y sum, and a feed as plain rows", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const block = { pageId: f.host, blockId: f.blockId };
    const chart = (yield* f.createView("Chart", "chart", {
      group: { property: ids.status },
      layout: { chartType: "bar", y: { property: ids.points, function: "sum" } },
      block,
    })).viewId;
    const feed = (yield* f.createView("Feed", "feed", {
      group: { property: ids.status },
      layout: { previewBlocks: 3 },
      block,
    })).viewId;
    const outside = yield* f.rootPage("Outside");
    const away = yield* f.kit.create("Away", { appendToPageId: outside });
    yield* f.kit.schema(f.dataSourceId, [
      {
        op: "addProperty",
        property: {
          id: C.SpacePropertyId.make("away0001"),
          name: "Away",
          type: "relation",
          config: { dataSourceId: away.dataSourceId, limit: "many" },
        },
      },
    ]);
    yield* f.createView("Hidden chart", "chart", {
      group: { property: C.SpacePropertyId.make("away0001"), by: "page" },
      block,
    });
    yield* f.createView("Ungrouped chart", "chart", { block });
    const described = yield* f.shares.database(f.token, undefined, f.blockId);
    assert.deepEqual(
      described.views.map((view) => view.type),
      ["table", "chart", "feed"],
    );
    assert.equal(described.views[2]!.group, undefined);
    const window = yield* f.shares.databaseQuery(f.token, f.request({ viewId: chart }));
    assert.deepEqual(window.rows, []);
    assert.deepEqual(
      window.groups!.map((bucket) => [bucket.count, bucket.rows.length, bucket.aggregates]),
      [1, 2, 3].map((n) => [1, 0, [{ property: ids.points, function: "sum", number: n }]]),
    );
    assert.notInclude(JSON.stringify(window), SECRET);
    const feedWindow = yield* f.shares.databaseQuery(f.token, f.request({ viewId: feed }));
    assert.isUndefined(feedWindow.groups);
    assert.lengthOf(feedWindow.rows, 3);
    assert.equal(
      yield* reason(f.shares.databaseQuery(f.token, f.request({ viewId: chart, group: "{}" }))),
      "SharedDatabaseRequestError",
    );
  }).pipe(Effect.provide(layerTest)),
);
