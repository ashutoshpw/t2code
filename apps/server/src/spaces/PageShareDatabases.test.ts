import { assert, it } from "@effect/vitest";
import { SPACE_PAGE_SHARE_TTL_MS, type SpaceSharedDatabaseWindow } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";

import {
  SECRET,
  hostname,
  ids,
  layerGated,
  layerTest,
  options,
  reason,
  sharedDatabase,
} from "./PageShareDatabases.testkit.ts";

const is = (
  property: C.SpacePropertyId,
  operator: "equals" | "is_not_empty",
  value?: C.SpaceOptionId,
): C.SpaceKnownFilter => ({ property, operator, ...(value === undefined ? {} : { value }) });

const json = (value: unknown) => JSON.stringify(value);

it.effect("describes a shared database with only the view's visible properties", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const described = yield* f.shares.database(f.token, undefined, f.blockId);
    assert.equal(described.database.title, "Tasks");
    assert.lengthOf(described.views, 1);
    assert.equal(described.views[0]!.type, "table");
    assert.deepEqual(
      described.views[0]!.properties.map((column) => column.propertyId),
      [ids.note, ids.points, ids.files, ids.status],
    );
    const text = json(described);
    for (const hidden of ["Secret", ids.secret, SECRET]) assert.notInclude(text, hidden);
    // Options travel with windows, never with the property.
    const status = described.dataSources[0]!.properties[ids.status]!;
    assert.deepEqual(status.config, { options: [] });
    const window = yield* f.shares.databaseQuery(f.token, f.request());
    assert.deepEqual(
      window.rows.map((row) => row.title),
      ["Row one", "Row two", "Row three"],
    );
    assert.deepEqual(window.rows[0]!.cells[ids.status], options.a);
    assert.isUndefined(window.rows[0]!.cells[ids.secret]);
    assert.deepEqual(
      window.options[ids.status]!.map((option) => option.name),
      ["Alpha", "Bravo", "Charlie"],
    );
    assert.isNull(window.nextCursor);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("answers forged ids exactly like missing ones", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const outside = yield* f.rootPage("Outside");
    const foreign = yield* f.kit.create("Foreign", { appendToPageId: outside });
    const child = yield* f.childPage(f.host, "Child");
    const other = yield* f.kit.create("Other", { appendToPageId: f.host });
    const unlisted = (yield* f.createView("Unlisted", "table", {})).viewId;
    const foreignRow = (yield* f.kit.addRows(foreign.dataSourceId, [{ title: "F" }])).rows[0]!
      .pageId;
    const base = f.request();
    const attempts = [
      reason(f.shares.databaseQuery(f.token, { ...base, pageId: child })),
      reason(f.shares.databaseQuery(f.token, { ...base, pageId: outside })),
      reason(f.shares.databaseQuery(f.token, { ...base, blockId: foreign.block!.blockId })),
      reason(f.shares.databaseQuery(f.token, { ...base, blockId: C.SpaceBlockId.make("nope") })),
      reason(f.shares.databaseQuery(f.token, { ...base, viewId: unlisted })),
      reason(f.shares.databaseQuery(f.token, { ...base, viewId: other.viewId })),
      reason(f.shares.databaseQuery(f.token, { ...base, viewId: C.SpaceViewId.make("nope") })),
      reason(f.shares.database(f.token, undefined, foreign.block!.blockId)),
      reason(f.shares.database(f.token, child, f.blockId)),
      reason(f.shares.databaseRow(f.token, { ...base, rowId: foreignRow })),
      reason(f.shares.databaseRow(f.token, { ...base, rowId: C.SpacePageId.make("nope") })),
      reason(f.shares.databaseRow(f.token, { ...base, rowId: outside })),
      reason(f.shares.databaseRow(f.token, { ...base, viewId: unlisted, rowId: f.rowIds[0]! })),
    ];
    for (const refusal of yield* Effect.all(attempts)) assert.equal(refusal, "unavailable");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps hidden and deleted properties out of every answer", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const doomed = C.SpacePropertyId.make("doom001");
    yield* f.kit.schema(f.dataSourceId, [
      { op: "addProperty", property: { id: doomed, name: "Doomed", type: "text" } },
    ]);
    yield* f.updateView(f.viewId, {
      properties: { set: { [doomed]: { visible: true } } },
      // The saved filter and sort run on the hidden column; the link may not show it.
      filter: is(ids.secret, "is_not_empty"),
      sorts: [{ property: ids.secret, direction: "descending" }],
    });
    yield* f.kit.setCells(f.dataSourceId, f.rowIds[0]!, {
      [doomed]: [{ text: "DOOMED-VALUE", marks: [] }],
    });
    const described = yield* f.shares.database(f.token, undefined, f.blockId);
    assert.include(json(described), "Doomed");
    yield* f.kit.schema(f.dataSourceId, [{ op: "removeProperty", propertyId: doomed }]);
    const answers = [
      yield* f.shares.database(f.token, undefined, f.blockId),
      yield* f.shares.databaseQuery(f.token, f.request()),
      yield* f.shares.databaseRow(f.token, f.request({ rowId: f.rowIds[0]! })),
    ];
    for (const answer of answers) {
      const text = json(answer);
      for (const secret of ["Secret", ids.secret, SECRET, "Doomed", "doom001", "DOOMED-VALUE"])
        assert.notInclude(text, secret);
      assert.notInclude(text, "deletedProperties");
    }
    // Sorted by the hidden column, descending.
    const window = yield* f.shares.databaseQuery(f.token, f.request());
    assert.deepEqual(
      window.rows.map((row) => row.title),
      ["Row three", "Row two", "Row one"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("never serves trashed rows or template rows", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const template = (yield* f.kit.addRows(f.dataSourceId, [
      { title: "A template", asTemplate: true },
    ])).rows[0]!.pageId;
    yield* f.recover(f.rowIds[1]!, "trash");
    const window = yield* f.shares.databaseQuery(f.token, f.request());
    assert.deepEqual(
      window.rows.map((row) => row.title),
      ["Row one", "Row three"],
    );
    for (const refused of [f.rowIds[1]!, template])
      assert.equal(
        yield* reason(f.shares.databaseRow(f.token, f.request({ rowId: refused }))),
        "unavailable",
      );
    assert.equal(
      (yield* f.shares.databaseRow(f.token, f.request({ rowId: f.rowIds[0]! }))).row.title,
      "Row one",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("gates rows and their assets by the saved filter at every request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* sharedDatabase();
      yield* f.updateView(f.viewId, { filter: is(ids.status, "equals", options.a) });
      const [kept, dropped] = [f.rowIds[0]!, f.rowIds[1]!];
      const asset = yield* f.uploadImage("pic");
      yield* f.attachImage(kept, "kept-image", asset);
      yield* f.attachImage(dropped, "dropped-image", asset);
      const row = (rowId: C.SpacePageId) => ({
        blockId: f.blockId,
        viewId: f.viewId,
        rowId,
      });
      assert.equal(
        yield* reason(f.shares.databaseRow(f.token, f.request({ rowId: dropped }))),
        "unavailable",
      );
      assert.equal(
        yield* reason(f.shares.asset(f.token, undefined, asset, row(dropped))),
        "unavailable",
      );
      const served = yield* f.shares.asset(f.token, undefined, asset, row(kept));
      assert.equal(served.mimeType, "image/png");
      // The plain form needs a block of the page named, and the row is not a page of the tree.
      assert.equal(yield* reason(f.shares.asset(f.token, undefined, asset)), "unavailable");
      // Editing the row so it fails the filter closes it on the next request.
      yield* f.kit.setCells(f.dataSourceId, kept, { [ids.status]: options.c });
      assert.equal(
        yield* reason(f.shares.databaseRow(f.token, f.request({ rowId: kept }))),
        "unavailable",
      );
      assert.equal(
        yield* reason(f.shares.asset(f.token, undefined, asset, row(kept))),
        "unavailable",
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("hides option names that no returned row uses", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    yield* f.updateView(f.viewId, { filter: is(ids.status, "equals", options.a) });
    const board = (yield* f.createView("Board", "board", {
      filter: is(ids.status, "equals", options.a),
      group: { property: ids.status },
      properties: [{ propertyId: ids.status, visible: true }],
      block: { pageId: f.host, blockId: f.blockId },
    })).viewId;
    const described = yield* f.shares.database(f.token, undefined, f.blockId);
    const answers = [
      described,
      yield* f.shares.databaseQuery(f.token, f.request()),
      yield* f.shares.databaseQuery(f.token, f.request({ viewId: board })),
    ];
    for (const answer of answers)
      for (const name of ["Bravo", "Charlie", options.b, options.c])
        assert.notInclude(json(answer), name);
    const grouped = yield* f.shares.databaseQuery(f.token, f.request({ viewId: board }));
    assert.deepEqual(
      grouped.groups!.map((bucket) => [bucket.key, bucket.count]),
      [[{ kind: "option", optionId: options.a }, 1]],
    );
    assert.deepEqual(
      grouped.options[ids.status]!.map((option) => option.name),
      ["Alpha"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("serves a linked view only when its database lives inside the shared tree", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    // Another page's database, linked into the shared page, is not published by the link.
    const elsewhere = yield* f.rootPage("Elsewhere");
    const away = yield* f.kit.create("Away", { appendToPageId: elsewhere });
    yield* f.kit.addRows(away.dataSourceId, [{ title: "Away row" }]);
    const awayRow = (yield* f.kit.addRows(away.dataSourceId, [{ title: "Away two" }])).rows[0]!
      .pageId;
    yield* f.insertBlock(f.host, f.linkedBlock("away-link", away.databaseId, [away.viewId]));
    const away_ = { blockId: C.SpaceBlockId.make("away-link"), viewId: away.viewId };
    assert.deepEqual(
      yield* Effect.all([
        reason(f.shares.database(f.token, undefined, away_.blockId)),
        reason(f.shares.databaseQuery(f.token, away_)),
        reason(f.shares.databaseRow(f.token, { ...away_, rowId: awayRow })),
      ]),
      ["unavailable", "unavailable", "unavailable"],
    );
    // A linked view of a database whose home page is inside the tree works.
    const child = yield* f.childPage(f.host, "Linked here");
    yield* f.insertBlock(child, f.linkedBlock("home-link", f.databaseId, [f.viewId]));
    const linked = { blockId: C.SpaceBlockId.make("home-link"), viewId: f.viewId };
    const window = yield* f.shares.databaseQuery(f.token, { ...linked, pageId: child });
    assert.lengthOf(window.rows, 3);
    assert.equal(
      (yield* f.shares.database(f.token, child, linked.blockId)).database.title,
      "Tasks",
    );
    // The block id is only valid on the page that holds it.
    assert.equal(yield* reason(f.shares.databaseQuery(f.token, linked)), "unavailable");
  }).pipe(Effect.provide(layerTest)),
);

/** A second database on a page outside the tree, with one row holding a secret. */
const outsideDatabase = Effect.fn("PageShareDatabasesTest.outside")(function* (
  f: Effect.Success<ReturnType<typeof sharedDatabase>>,
) {
  const outside = yield* f.rootPage("Outside");
  const created = yield* f.kit.create("Vault", {
    appendToPageId: outside,
    properties: [{ id: C.SpacePropertyId.make("vault001"), name: "Vault", type: "text" }],
  });
  const row = (yield* f.kit.addRows(created.dataSourceId, [
    {
      title: "Vault row",
      icon: "🔒",
      cells: { vault001: [{ text: "VAULT-SECRET", marks: [] }] },
    },
  ])).rows[0]!.pageId;
  return { created, row };
});

const addRelation = (
  f: Effect.Success<ReturnType<typeof sharedDatabase>>,
  id: string,
  name: string,
  target: C.SpaceDataSourceId,
) =>
  f.kit.schema(f.dataSourceId, [
    {
      op: "addProperty",
      property: {
        id: C.SpacePropertyId.make(id),
        name,
        type: "relation",
        config: { dataSourceId: target, limit: "many" },
      },
    },
  ]);

it.effect("exposes a relation only when its target is shared, and then only titles", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const { created, row } = yield* outsideDatabase(f);
    const projects = (yield* f.spaces.createDataSource({
      ...f.common,
      mutationId: "projects",
      databaseId: f.databaseId,
      name: "Projects",
    })).dataSourceId;
    const project = (yield* f.kit.addRows(projects, [
      { title: "Project P", icon: "📁", cells: { title: "Project P" } },
    ])).rows[0]!.pageId;
    yield* addRelation(f, "inside01", "Inside", projects);
    yield* addRelation(f, "away0001", "Away", created.dataSourceId);
    yield* f.kit.setCells(f.dataSourceId, f.rowIds[0]!, {
      inside01: [project],
      away0001: [row],
    });
    yield* f.updateView(f.viewId, {
      properties: {
        set: { inside01: { visible: true }, away0001: { visible: true } },
      },
    });
    const answers = [
      yield* f.shares.database(f.token, undefined, f.blockId),
      yield* f.shares.databaseQuery(f.token, f.request()),
      yield* f.shares.databaseRow(f.token, f.request({ rowId: f.rowIds[0]! })),
    ];
    for (const answer of answers) {
      for (const leak of ["away0001", "Away", "Vault row", "VAULT-SECRET", "🔒", "vault001"])
        assert.notInclude(json(answer), leak);
    }
    const window = yield* f.shares.databaseQuery(f.token, f.request());
    assert.deepEqual(window.rows[0]!.cells["inside01"], [project]);
    assert.deepEqual(window.relatedPages[project], {
      title: "Project P",
      icon: "📁",
      dataSourceId: projects,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("drops computed columns that could carry content from outside the tree", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const { created, row } = yield* outsideDatabase(f);
    yield* addRelation(f, "away0001", "Away", created.dataSourceId);
    yield* f.kit.setCells(f.dataSourceId, f.rowIds[0]!, { away0001: [row] });
    const computed = (
      id: string,
      name: string,
      type: "formula" | "rollup",
      config: C.SpaceCellValue,
    ) =>
      f.kit.schema(f.dataSourceId, [
        { op: "addProperty", property: { id: C.SpacePropertyId.make(id), name, type, config } },
      ]);
    yield* computed("roll0001", "Rolled", "rollup", {
      relationPropertyId: "away0001",
      targetPropertyId: "vault001",
      function: "show_original",
    });
    yield* computed("form0001", "Mapped", "formula", {
      expression: 'prop("Away").map(current.prop("Vault"))',
    });
    // Reads an ineligible formula of its own row: ineligible in turn.
    yield* computed("chain001", "Chained", "formula", { expression: 'prop("Mapped")' });
    yield* computed("plain001", "Doubled", "formula", { expression: 'prop("Points") * 2' });
    // Control: the same shape over a relation inside the tree is exposed.
    const projects = (yield* f.spaces.createDataSource({
      ...f.common,
      mutationId: "projects-control",
      databaseId: f.databaseId,
      name: "Projects",
    })).dataSourceId;
    yield* addRelation(f, "inside01", "Inside", projects);
    yield* computed("kept0001", "Titles", "rollup", {
      relationPropertyId: "inside01",
      targetPropertyId: "title",
      function: "show_original",
    });
    // Reads the clock, and a formula whose input was deleted ends in error.
    yield* computed("clock001", "Clock", "formula", { expression: "now()" });
    yield* f.kit.schema(f.dataSourceId, [
      {
        op: "addProperty",
        property: { id: C.SpacePropertyId.make("temp0001"), name: "Temp", type: "number" },
      },
    ]);
    yield* computed("gone0001", "Gone", "formula", { expression: 'prop("Temp") + 1' });
    yield* f.kit.schema(f.dataSourceId, [
      { op: "removeProperty", propertyId: C.SpacePropertyId.make("temp0001") },
    ]);
    const columns = [
      "roll0001",
      "form0001",
      "chain001",
      "plain001",
      "clock001",
      "away0001",
      "kept0001",
    ];
    yield* f.updateView(f.viewId, {
      properties: { set: Object.fromEntries(columns.map((id) => [id, { visible: true }])) },
    });
    const described = yield* f.shares.database(f.token, undefined, f.blockId);
    const shown = described.views[0]!.properties.map((column) => column.propertyId);
    assert.include(shown.map(String), "plain001");
    assert.include(shown.map(String), "kept0001");
    for (const hidden of ["roll0001", "form0001", "chain001", "clock001", "away0001", "gone0001"])
      assert.notInclude(shown.map(String), hidden);
    const window = yield* f.shares.databaseQuery(f.token, f.request());
    assert.deepEqual(window.rows[0]!.cells["plain001"], { type: "number", value: 2 });
    for (const answer of [
      described,
      window,
      yield* f.shares.databaseRow(f.token, f.request({ rowId: f.rowIds[0]! })),
    ])
      for (const leak of [
        "VAULT-SECRET",
        "Vault row",
        "roll0001",
        "form0001",
        "chain001",
        "clock001",
      ])
        assert.notInclude(json(answer), leak);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("withholds a view whose layout needs a property the link cannot show", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    yield* f.kit.schema(f.dataSourceId, [
      {
        op: "addProperty",
        property: { id: C.SpacePropertyId.make("due0001"), name: "Due", type: "date" },
      },
      {
        op: "addProperty",
        property: {
          id: C.SpacePropertyId.make("clock001"),
          name: "Clock",
          type: "formula",
          config: { expression: "now()" },
        },
      },
    ]);
    const block = { pageId: f.host, blockId: f.blockId };
    const calendar = (yield* f.createView("Calendar", "calendar", {
      layout: { datePropertyId: "due0001" },
      block,
    })).viewId;
    const board = (yield* f.createView("Board", "board", {
      group: { property: ids.status },
      block,
    })).viewId;
    const described = yield* f.shares.database(f.token, undefined, f.blockId);
    assert.deepEqual(
      described.views.map((view) => view.type),
      ["table", "calendar", "board"],
    );
    // A calendar whose date property is deleted is dropped, not the block or the other views.
    yield* f.kit.schema(f.dataSourceId, [
      { op: "removeProperty", propertyId: C.SpacePropertyId.make("due0001") },
    ]);
    const after = yield* f.shares.database(f.token, undefined, f.blockId);
    assert.notInclude(
      after.views.map((view) => view.id),
      calendar,
    );
    assert.include(
      after.views.map((view) => view.id),
      board,
    );
    assert.equal(
      yield* reason(
        f.shares.databaseQuery(
          f.token,
          f.request({ viewId: calendar, from: "2026-11-01", to: "2026-11-30" }),
        ),
      ),
      "unavailable",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("never returns saved group keys that carry free text or hidden buckets", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const hiddenKey = { kind: "option", optionId: options.b } as const;
    const board = (yield* f.createView("Board", "board", {
      group: {
        property: ids.status,
        hidden: [hiddenKey],
        order: [
          { kind: "text", value: "SECRET-CLIENT-NO-ROW-RETURNED" },
          { kind: "option", optionId: options.a },
          hiddenKey,
        ],
      },
      block: { pageId: f.host, blockId: f.blockId },
    })).viewId;
    const described = yield* f.shares.database(f.token, undefined, f.blockId);
    const text = json(described);
    for (const leak of ["SECRET-CLIENT-NO-ROW-RETURNED", options.b]) assert.notInclude(text, leak);
    const view = described.views.find((candidate) => candidate.id === board)!;
    assert.deepEqual(view.group?.order, [{ kind: "option", optionId: options.a }]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("hides a hidden bucket and refuses it as a scope", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const hiddenKey = { kind: "option", optionId: options.b } as const;
    const board = (yield* f.createView("Board", "board", {
      group: { property: ids.status, hidden: [hiddenKey] },
      block: { pageId: f.host, blockId: f.blockId },
    })).viewId;
    const grouped = yield* f.shares.databaseQuery(f.token, f.request({ viewId: board }));
    assert.deepEqual(
      grouped.groups!.map((bucket) => bucket.key),
      [
        { kind: "option", optionId: options.a },
        { kind: "option", optionId: options.c },
      ],
    );
    assert.notInclude(json(grouped), "Bravo");
    assert.equal(
      yield* reason(
        f.shares.databaseQuery(f.token, {
          ...f.request({ viewId: board }),
          group: JSON.stringify(hiddenKey),
        }),
      ),
      "unavailable",
    );
    const open = yield* f.shares.databaseQuery(f.token, {
      ...f.request({ viewId: board }),
      group: JSON.stringify({ kind: "option", optionId: options.a }),
    });
    assert.deepEqual(
      open.rows.map((row) => row.title),
      ["Row one"],
    );
  }).pipe(Effect.provide(layerTest)),
);

/** Requests the scoped rows of `view` for each key and answers the error tag, or "ok" with its row titles. */
const scoped = Effect.fn("PageShareDatabasesTest.scoped")(function* (
  f: Effect.Success<ReturnType<typeof sharedDatabase>>,
  viewId: string,
  key: object,
) {
  const outcome = yield* Effect.result(
    f.shares.databaseQuery(f.token, { ...f.request({ viewId }), group: JSON.stringify(key) }),
  );
  if (outcome._tag === "Success") return outcome.success.rows.map((row) => row.title);
  const { failure } = outcome;
  return "reason" in failure ? String(failure.reason) : failure._tag;
});

it.effect("treats only the exact number range as the hidden bucket", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    yield* f.kit.setCells(f.dataSourceId, f.rowIds[0]!, { [ids.points]: 2 });
    yield* f.kit.setCells(f.dataSourceId, f.rowIds[1]!, { [ids.points]: 3 });
    const hiddenKey = { kind: "number_range", start: 2, end: 4 } as const;
    const board = (yield* f.createView("Board", "board", {
      group: { property: ids.points, by: { range: { start: 0, size: 2 } }, hidden: [hiddenKey] },
      block: { pageId: f.host, blockId: f.blockId },
    })).viewId;
    assert.equal(yield* scoped(f, board, hiddenKey), "unavailable");
    for (const alias of [
      { kind: "number_range", start: 2, end: 1003 },
      { kind: "number_range", start: 2.4, end: 4.4 },
      { kind: "number_range", start: 3, end: 5 },
      { kind: "number_range", start: 2, end: 3 },
    ])
      assert.equal(yield* scoped(f, board, alias), "SharedDatabaseRequestError");
    assert.deepEqual(yield* scoped(f, board, { kind: "number_range", start: 0, end: 2 }), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("treats only the exact date bucket start as the hidden bucket", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    yield* f.kit.schema(f.dataSourceId, [
      {
        op: "addProperty",
        property: { id: C.SpacePropertyId.make("due0001"), name: "Due", type: "date" },
      },
    ]);
    yield* f.kit.setCells(f.dataSourceId, f.rowIds[0]!, { due0001: { start: "2026-11-10" } });
    const block = { pageId: f.host, blockId: f.blockId };
    const cases = [
      { by: "week", start: "2026-11-08", alias: ["2026-11-10", "2026-11-09", "2026-11-14"] },
      { by: "month", start: "2026-11-01", alias: ["2026-11-10", "2026-11-30"] },
      { by: "year", start: "2026-01-01", alias: ["2026-06-01", "2026-12-31"] },
    ] as const;
    for (const { by, start, alias } of cases) {
      const hiddenKey = { kind: "date", start, unit: by } as const;
      const board = (yield* f.createView(`Board ${by}`, "board", {
        group: { property: C.SpacePropertyId.make("due0001"), by, hidden: [hiddenKey] },
        block,
      })).viewId;
      assert.equal(yield* scoped(f, board, hiddenKey), "unavailable");
      for (const other of alias)
        assert.equal(
          yield* scoped(f, board, { kind: "date", start: other, unit: by }),
          "SharedDatabaseRequestError",
        );
      assert.equal(
        yield* scoped(f, board, { kind: "date", start, unit: by === "week" ? "day" : "week" }),
        "SharedDatabaseRequestError",
      );
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("cleans rich text and file cells", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    yield* f.kit.setCells(f.dataSourceId, f.rowIds[0]!, {
      [ids.note]: [
        {
          text: "see ",
          marks: [
            { type: "bold", version: 1 },
            { type: "link", version: 1, href: "javascript:alert(1)" },
          ],
        },
        {
          text: "page",
          marks: [
            {
              type: "page_mention",
              version: 1,
              target: { environmentId: f.common.environmentId, pageId: f.host },
            },
            { type: "link", version: 1, href: "https://ok.example" },
          ],
        },
      ],
      [ids.files]: [{ name: "ok", url: "https://ok.example/a.png" }],
    });
    const window = yield* f.shares.databaseQuery(f.token, f.request());
    assert.deepEqual(window.rows[0]!.cells[ids.note], [
      { text: "see ", marks: [{ type: "bold", version: 1 }] },
      { text: "page", marks: [{ type: "link", version: 1, href: "https://ok.example" }] },
    ]);
    assert.deepEqual(window.rows[0]!.cells[ids.files], [
      { name: "ok", url: "https://ok.example/a.png" },
    ]);
    assert.notInclude(json(window), "javascript");
    assert.notInclude(json(window), "page_mention");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("never returns a field that belongs to the signed-in database wire", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const board = (yield* f.createView("Board", "board", {
      group: { property: ids.status },
      sorts: [{ property: ids.points, direction: "ascending" }],
      block: { pageId: f.host, blockId: f.blockId },
    })).viewId;
    const answers = [
      yield* f.shares.database(f.token, undefined, f.blockId),
      yield* f.shares.databaseQuery(f.token, f.request()),
      yield* f.shares.databaseQuery(f.token, f.request({ viewId: board })),
    ];
    const keys = [
      "mutationAdmission",
      "spaceId",
      "home",
      "templates",
      "defaultTemplateId",
      "revision",
      "createdAt",
      "updatedAt",
      "computedPending",
      "ownerBlockId",
      "filter",
      "sorts",
      "deletedProperties",
      "description",
      "inputs",
      "total",
      "aggregates",
      "subGroups",
      "number",
    ];
    for (const answer of answers)
      for (const key of keys) assert.notInclude(json(answer), `"${key}":`);
    const row = yield* f.shares.databaseRow(f.token, f.request({ rowId: f.rowIds[0]! }));
    for (const key of keys.filter((key) => key !== "revision"))
      assert.notInclude(json(row), `"${key}":`);
  }).pipe(Effect.provide(layerTest)),
);

/** `count` rows with a hidden `rank` that decides the saved order. */
const bulk = Effect.fn("PageShareDatabasesTest.bulk")(function* (
  f: Effect.Success<ReturnType<typeof sharedDatabase>>,
  count: number,
) {
  yield* f.kit.schema(f.dataSourceId, [
    {
      op: "addProperty",
      property: { id: C.SpacePropertyId.make("rank0001"), name: "Rank", type: "number" },
    },
  ]);
  const pick = [options.a, options.b, options.c];
  for (let start = 0; start < count; start += 100) {
    yield* f.kit.addRows(
      f.dataSourceId,
      Array.from({ length: Math.min(100, count - start) }, (_, i) => ({
        title: `Bulk ${String(start + i).padStart(3, "0")}`,
        cells: { rank0001: 1000 - (start + i), [ids.status]: pick[(start + i) % 3]! },
      })),
    );
  }
});

it.effect("seals cursors and binds them to the share, page, block and view", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    yield* bulk(f, 117);
    yield* f.updateView(f.viewId, {
      sorts: [{ property: C.SpacePropertyId.make("rank0001"), direction: "ascending" }],
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    const first = yield* f.shares.databaseQuery(f.token, f.request());
    cursor = first.nextCursor!;
    assert.lengthOf(first.rows, 50);
    // The sort key is a hidden number: the cursor must not be readable JSON.
    assert.throws(() => JSON.parse(Buffer.from(cursor!, "base64url").toString("utf8")));
    assert.notInclude(json(first), "rank0001");
    seen.push(...first.rows.map((row) => row.id));
    while (cursor !== undefined) {
      const next: SpaceSharedDatabaseWindow = yield* f.shares.databaseQuery(
        f.token,
        f.request({ cursor }),
      );
      seen.push(...next.rows.map((row) => row.id));
      cursor = next.nextCursor ?? undefined;
    }
    assert.equal(seen.length, 120);
    assert.equal(new Set(seen).size, 120);
    // Rows come back in the saved order, the three seeded rows last (their rank is empty).
    const sealed = first.nextCursor!;
    const other = (yield* f.createView("Other", "table", {
      sorts: [{ property: C.SpacePropertyId.make("rank0001"), direction: "ascending" }],
      block: { pageId: f.host, blockId: f.blockId },
    })).viewId;
    const child = yield* f.childPage(f.host, "Child");
    yield* f.insertBlock(child, f.linkedBlock("child-link", f.databaseId, [f.viewId]));
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`;
    const refused = [
      f.shares.databaseQuery(f.token, f.request({ viewId: other, cursor: sealed })),
      f.shares.databaseQuery(f.token, {
        blockId: C.SpaceBlockId.make("child-link"),
        viewId: f.viewId,
        pageId: child,
        cursor: sealed,
      }),
      f.shares.databaseQuery(f.token, f.request({ cursor: tampered })),
      f.shares.databaseQuery(f.token, f.request({ cursor: "short" })),
    ];
    for (const attempt of refused) assert.equal(yield* reason(attempt), "unavailable");
    const replaced = (yield* f.shares.create({ pageId: f.host })).url.split("#")[1]!;
    assert.equal(
      yield* reason(f.shares.databaseQuery(replaced, f.request({ cursor: sealed }))),
      "unavailable",
    );
    assert.equal(
      yield* reason(f.shares.databaseQuery(f.token, f.request({ cursor: sealed }))),
      "inactive",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "windows rows, buckets and date ranges, and refuses requests that do not fit the view",
  () =>
    Effect.gen(function* () {
      const f = yield* sharedDatabase();
      yield* bulk(f, 117);
      const block = { pageId: f.host, blockId: f.blockId };
      const board = (yield* f.createView("Board", "board", {
        group: { property: ids.status },
        block,
      })).viewId;
      const table = yield* f.shares.databaseQuery(f.token, f.request());
      assert.deepEqual([table.rows.length, table.nextCursor === null], [50, false]);
      const grouped = yield* f.shares.databaseQuery(f.token, f.request({ viewId: board }));
      assert.isTrue(grouped.groups!.every((bucket) => bucket.rows.length === 10));
      assert.deepEqual(
        grouped.groups!.map((bucket) => bucket.count),
        [40, 40, 40],
      );
      const bucket = grouped.groups![0]!;
      const more = yield* f.shares.databaseQuery(f.token, {
        ...f.request({ viewId: board }),
        group: JSON.stringify(bucket.key),
        cursor: bucket.nextCursor!,
      });
      assert.lengthOf(more.rows, 30);
      assert.isNull(more.nextCursor);
      assert.isFalse(more.rows.some((row) => bucket.rows.some((seen) => seen.id === row.id)));

      yield* f.kit.schema(f.dataSourceId, [
        {
          op: "addProperty",
          property: { id: C.SpacePropertyId.make("due0001"), name: "Due", type: "date" },
        },
      ]);
      yield* f.kit.setCells(f.dataSourceId, f.rowIds[0]!, { due0001: { start: "2026-11-20" } });
      yield* f.kit.setCells(f.dataSourceId, f.rowIds[1]!, {
        due0001: { start: "2026-11-10", end: "2026-11-21" },
      });
      yield* f.kit.setCells(f.dataSourceId, f.rowIds[2]!, { due0001: { start: "2026-12-30" } });
      const calendar = (yield* f.createView("Cal", "calendar", {
        layout: { datePropertyId: "due0001" },
        block,
      })).viewId;
      const month = yield* f.shares.databaseQuery(f.token, {
        ...f.request({ viewId: calendar }),
        from: "2026-11-15",
        to: "2026-11-30",
      });
      assert.deepEqual(
        month.rows.map((row) => row.title),
        ["Row two", "Row one"],
      );
      const bad = (extra: object, viewId = calendar) =>
        Effect.map(
          Effect.flip(f.shares.databaseQuery(f.token, { ...f.request({ viewId }), ...extra })),
          (error) => error._tag,
        );
      for (const extra of [
        {},
        { from: "2026-11-15" },
        { from: "2026-12-01", to: "2026-11-01" },
        { from: "2026-01-01", to: "2026-06-30" },
        { from: "2026-02-30", to: "2026-03-01" },
        { from: "yesterday", to: "today" },
        { from: "2026-11-01", to: "2026-11-30", group: "{}" },
      ])
        assert.equal(yield* bad(extra), "SharedDatabaseRequestError");
      // Date ranges belong to calendars; groups belong to grouped views; cursors to row windows.
      assert.equal(
        yield* bad({ from: "2026-11-01", to: "2026-11-30" }, f.viewId),
        "SharedDatabaseRequestError",
      );
      assert.equal(
        yield* bad({ group: JSON.stringify(bucket.key) }, f.viewId),
        "SharedDatabaseRequestError",
      );
      assert.equal(yield* bad({ cursor: bucket.nextCursor }, board), "SharedDatabaseRequestError");
      assert.equal(yield* bad({ group: "not json" }, board), "SharedDatabaseRequestError");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("pages a row's body and serves its images only through the row form", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* sharedDatabase();
      const row = f.rowIds[0]!;
      const asset = yield* f.uploadImage("cover");
      const stray = yield* f.uploadImage("stray");
      yield* f.attachImage(row, "row-image", asset);
      yield* f.attachImage(f.rowIds[1]!, "other-image", stray);
      for (let i = 0; i < 120; i++)
        yield* f.insertBlock(row, {
          id: C.SpaceBlockId.make(`body-${String(i).padStart(3, "0")}`),
          parentId: null,
          order: (i + 2).toString(16).padStart(32, "0"),
          type: "paragraph",
          version: 1,
          content: { runs: [{ text: `line ${i}`, marks: [] }] },
        });
      const board = (yield* f.createView("Gallery", "gallery", {
        properties: [{ propertyId: ids.points, visible: true }],
        layout: { cardPreview: { kind: "page_cover" } },
        block: { pageId: f.host, blockId: f.blockId },
      })).viewId;
      const page = yield* f.shares.databaseRow(f.token, f.request({ rowId: row }));
      assert.deepEqual(
        Object.keys(page.row.cells).sort(),
        [ids.note, ids.points, ids.status].sort(),
      );
      assert.isUndefined(page.row.cells[ids.secret]);
      assert.deepEqual(
        page.breadcrumb.map((crumb) => crumb.title),
        ["Host", "Row one"],
      );
      assert.equal(page.window.blocks.length, 100);
      const rest = yield* f.shares.databaseRow(
        f.token,
        f.request({ rowId: row, cursor: page.nextCursor! }),
      );
      assert.equal(page.window.blocks.length + rest.window.blocks.length, 121);
      assert.isUndefined(rest.nextCursor);
      // The card cover is the row's first image and is served through the row form only.
      const cards = yield* f.shares.databaseQuery(f.token, f.request({ viewId: board }));
      assert.equal(cards.rows[0]!.cover?.assetId, asset);
      const target = { blockId: f.blockId, viewId: board, rowId: row };
      assert.equal(
        (yield* f.shares.asset(f.token, undefined, asset, target)).mimeType,
        "image/png",
      );
      assert.equal(yield* reason(f.shares.asset(f.token, undefined, asset)), "unavailable");
      assert.equal(yield* reason(f.shares.asset(f.token, undefined, stray, target)), "unavailable");
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("ends every database route with the link, and with the page and database it names", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const settings = yield* Settings.ServerSettingsService;
    const reasons = (token: string, page?: C.SpacePageId, blockId = f.blockId) =>
      Effect.all([
        reason(f.shares.database(token, page, blockId)),
        reason(
          f.shares.databaseQuery(token, {
            ...f.request({ blockId }),
            ...(page ? { pageId: page } : {}),
          }),
        ),
        reason(
          f.shares.databaseRow(token, {
            ...f.request({ blockId, rowId: f.rowIds[0]! }),
            ...(page ? { pageId: page } : {}),
          }),
        ),
      ]);
    const all = (word: string) => [word, word, word];
    assert.lengthOf((yield* f.shares.databaseQuery(f.token, f.request())).rows, 3);

    yield* settings.updateSettings({ spacesPageSharingEnabled: false });
    assert.deepEqual(yield* reasons(f.token), all("inactive"));
    yield* settings.updateSettings({ spacesPageSharingEnabled: true });
    yield* Ref.set(hostname, "other.t2.test");
    assert.deepEqual(yield* reasons(f.token), all("inactive"));
    yield* Ref.set(hostname, "env.t2.test");
    assert.lengthOf((yield* f.shares.databaseQuery(f.token, f.request())).rows, 3);

    // A database on a sub-page: the sub-page being trashed makes it unavailable; restore brings it back.
    const child = yield* f.childPage(f.host, "Holder");
    const held = yield* f.kit.create("Held", { appendToPageId: child });
    yield* f.kit.addRows(held.dataSourceId, [{ title: "H" }]);
    const heldRequest = { blockId: held.block!.blockId, viewId: held.viewId, pageId: child };
    assert.lengthOf((yield* f.shares.databaseQuery(f.token, heldRequest)).rows, 1);
    yield* f.recover(child, "trash");
    assert.equal(yield* reason(f.shares.databaseQuery(f.token, heldRequest)), "unavailable");
    yield* f.recover(child, "restore");
    assert.lengthOf((yield* f.shares.databaseQuery(f.token, heldRequest)).rows, 1);
    // Deleting the home block kills the database: the page still loads, the block does not.
    const page = yield* f.spaces.getPage({ environmentId: f.common.environmentId, pageId: child });
    yield* f.spaces.applyBlockBatch({
      ...f.common,
      mutationId: "delete-home",
      pageId: child,
      baseRevision: page.page.revision,
      generation: 0,
      mutations: [{ kind: "delete", blockId: held.block!.blockId }],
    });
    assert.equal(yield* reason(f.shares.databaseQuery(f.token, heldRequest)), "unavailable");

    // The host page itself: trashing the root ends the link.
    yield* f.recover(f.host, "trash");
    assert.deepEqual(yield* reasons(f.token), all("inactive"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("stops serving a stopped, replaced or expired link on every route", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const probe = (token: string) =>
      Effect.all([
        reason(f.shares.database(token, undefined, f.blockId)),
        reason(f.shares.databaseQuery(token, f.request())),
        reason(f.shares.databaseRow(token, f.request({ rowId: f.rowIds[0]! }))),
      ]);
    const replaced = (yield* f.shares.create({ pageId: f.host })).url.split("#")[1]!;
    assert.deepEqual(yield* probe(f.token), ["inactive", "inactive", "inactive"]);
    yield* f.shares.stop({ pageId: f.host });
    assert.deepEqual(yield* probe(replaced), ["inactive", "inactive", "inactive"]);
    const fresh = (yield* f.shares.create({ pageId: f.host })).url.split("#")[1]!;
    yield* TestClock.adjust(Duration.millis(SPACE_PAGE_SHARE_TTL_MS));
    assert.deepEqual(yield* probe(fresh), ["inactive", "inactive", "inactive"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reads while another connection holds the write lock and writes nothing", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const config = yield* ServerConfig.ServerConfig;
    yield* TestClock.adjust(Duration.minutes(1));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const state = sql`SELECT (SELECT observed_time_ms FROM spaces_core WHERE singleton = 1) AS observed,
        (SELECT COUNT(*) FROM spaces_pages) AS pages, (SELECT SUM(data_revision) FROM spaces_db_data_sources) AS data,
        (SELECT COUNT(*) FROM spaces_db_cells) AS cells, (SELECT SUM(revision) FROM spaces_pages) AS revisions`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE spaces_core SET observed_time_ms = observed_time_ms WHERE singleton = 1`;
          const before = yield* state;
          assert.lengthOf((yield* f.shares.database(f.token, undefined, f.blockId)).views, 1);
          assert.lengthOf((yield* f.shares.databaseQuery(f.token, f.request())).rows, 3);
          assert.equal(
            (yield* f.shares.databaseRow(f.token, f.request({ rowId: f.rowIds[0]! }))).row.title,
            "Row one",
          );
          assert.deepEqual(yield* state, before);
        }),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps database work in its own pool of eight so page reads are never starved", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const entered = yield* Queue.unbounded<void>();
    return yield* Effect.gen(function* () {
      const f = yield* sharedDatabase();
      const held = yield* Effect.forEach(Array.from({ length: 8 }), () =>
        f.shares.database(f.token, undefined, f.blockId).pipe(Effect.forkChild),
      );
      for (let i = 0; i < 8; i++) yield* Queue.take(entered);
      assert.equal(yield* reason(f.shares.database(f.token, undefined, f.blockId)), "busy");
      assert.equal(yield* reason(f.shares.databaseQuery(f.token, f.request())), "busy");
      assert.equal((yield* f.shares.page(f.token)).page.title, "Host");
      yield* Deferred.succeed(gate, undefined);
      for (const fiber of held) assert.lengthOf((yield* Fiber.join(fiber)).views, 1);
      assert.lengthOf((yield* f.shares.database(f.token, undefined, f.blockId)).views, 1);
    }).pipe(Effect.provide(layerGated(gate, entered)));
  }),
);
