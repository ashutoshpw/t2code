import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { block, boot, env, fixture, moveIntent, recoveryIntent } from "./Spaces.testkit.ts";
import {
  cellRows,
  databaseError,
  databaseKit,
  exec,
  limitError,
  rowOrder,
  oid,
  raw,
  validationReason,
  warmSearch,
} from "./Databases.testkit.ts";

const iso = "2026-11-11T10:00:00.000Z";
const run = (text: string) => [{ text, marks: [] }];

it.layer(NodeServices.layer)("Spaces database rows", (it) => {
  it.effect("keeps a row a full page: body, title, pin, search, mention, trash and restore", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Tasks", { appendToPageId: page.id });
        const made = yield* kit.addRows(created.dataSourceId, [{ title: "Ship it" }]);
        const rowId = made.rows[0]!.pageId;
        const summary = (yield* service.getPage({ ...env, pageId: rowId })).page;
        assert.deepEqual(summary.row, { dataSourceId: created.dataSourceId });
        assert.isUndefined(summary.location);
        assert.equal(summary.revision, 0);

        // Body editing keeps the existing block revision rules.
        const body = yield* service.applyBlockBatch({
          ...common,
          mutationId: "row-body",
          pageId: rowId,
          baseRevision: 0,
          generation: 0,
          mutations: [{ kind: "insert", block: block("rowbody", 1) }],
        });
        assert.equal(body.status, "saved");
        const bodyBlocks = yield* service.readBlocks({ ...env, pageId: rowId, revision: 1 });
        assert.deepEqual(
          bodyBlocks.blocks.map((entry) => entry.id),
          ["rowbody"],
        );

        // The title is the title property: a page rename follows into the cell and the data revision.
        const before = (yield* kit.get(created.databaseId)).dataSources[0]!.dataRevision;
        yield* service.updatePage({
          ...common,
          mutationId: "row-rename",
          pageId: rowId,
          baseRevision: 1,
          title: "Ship it now",
        });
        assert.equal((yield* kit.row(rowId)).row.cells.title, "Ship it now");
        assert.equal((yield* kit.get(created.databaseId)).dataSources[0]!.dataRevision, before + 1);
        yield* service.updateRows({
          ...common,
          mutationId: "row-title-cell",
          dataSourceId: created.dataSourceId,
          rows: [{ pageId: rowId, cells: { title: "Ship it today" } }],
        });
        assert.equal(
          (yield* service.getPage({ ...env, pageId: rowId })).page.title,
          "Ship it today",
        );
        assert.equal((yield* service.getPage({ ...env, pageId: rowId })).page.revision, 3);
        assert.equal((yield* kit.get(created.databaseId)).dataSources[0]!.dataRevision, before + 2);
        assert.lengthOf(yield* cellRows(dbPath, rowId, "title"), 1);

        yield* warmSearch(service);
        yield* service.addPin({ ...env, pageId: rowId });
        assert.deepEqual(
          (yield* service.listPins(env)).items.map((item) => item.page.id),
          [rowId],
        );
        assert.deepEqual(
          (yield* service.search({ ...env, query: "today" })).items.map((item) => item.page.id),
          [rowId],
        );
        assert.deepEqual(
          (yield* service.search({ ...env, query: "rowbody" })).items.map((item) => item.page.id),
          [rowId],
        );
        const resolved = yield* service.resolveReference({
          ...env,
          target: { kind: "page", pageId: rowId },
        });
        assert.equal(resolved.status, "resolved");

        // Rows and templates never appear in "all pages".
        const all = yield* service.listAllPages(env);
        assert.isFalse(all.items.some((item) => item.page.id === rowId));

        // A row can never leave its data source for the page tree.
        const toRoot = yield* moveIntent(service, common, rowId, "row-move", {
          kind: "root",
          spaceId: page.spaceId,
          beforePageId: null,
        });
        assert.equal(yield* validationReason(service.movePage(toRoot)), "invalid_parent");

        // Trash, restore, and permanent delete follow the page rules.
        yield* service.trashPage(
          yield* recoveryIntent(service, common, rowId, "trash", "row-trash"),
        );
        assert.deepEqual(
          (yield* service.listTrash(env)).items.map((item) => item.pageId),
          [rowId],
        );
        const restored = yield* service.restorePage(
          yield* recoveryIntent(service, common, rowId, "restore", "row-restore"),
        );
        assert.equal(restored.status, "saved");
        const back = (yield* service.getPage({ ...env, pageId: rowId })).page;
        assert.deepEqual(back.row, { dataSourceId: created.dataSourceId });
        assert.isNull(back.rootOrder);
        assert.isUndefined(back.location);
        yield* service.trashPage(
          yield* recoveryIntent(service, common, rowId, "trash", "row-trash-2"),
        );
        yield* service.permanentlyDeletePage(
          yield* recoveryIntent(service, common, rowId, "permanentlyDelete", "row-purge"),
        );
        const counters = yield* raw(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return {
              source: yield* sql`SELECT row_count, next_row_seq FROM spaces_db_data_sources`,
              cells:
                yield* sql`SELECT COUNT(*) AS count FROM spaces_db_cells WHERE page_id = ${rowId}`,
            };
          }),
        );
        assert.deepEqual(counters.source, [{ row_count: 0, next_row_seq: 2 }]);
        assert.deepEqual(counters.cells, [{ count: 0 }]);
        assert.equal((yield* Effect.flip(kit.row(rowId)))._tag, "SpaceNotFoundError");
      }),
    ),
  );

  it.effect("hides a template row from search while keeping it a row", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Docs", { appendToPageId: page.id });
        const made = yield* kit.addRows(created.dataSourceId, [
          { title: "Needle template", asTemplate: true },
          { title: "Needle row" },
        ]);
        assert.isTrue((yield* kit.row(made.rows[0]!.pageId)).template);
        yield* warmSearch(service);
        assert.deepEqual(
          (yield* service.search({ ...env, query: "Needle" })).items.map((item) => item.page.id),
          [made.rows[1]!.pageId],
        );
        const got = yield* kit.get(created.databaseId);
        assert.deepEqual(
          got.dataSources[0]!.templates.map((template) => template.pageId),
          [made.rows[0]!.pageId],
        );
      }),
    ),
  );

  it.effect(
    "lets writers to different cells of one row both land and the later same-cell write win",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const kit = databaseKit(service, common, page.spaceId);
          const created = yield* kit.create("Tasks", {
            appendToPageId: page.id,
            properties: [
              { name: "Points", type: "number" },
              { name: "Note", type: "url" },
            ],
          });
          const [points, note] = created.propertyIds as [C.SpacePropertyId, C.SpacePropertyId];
          const made = yield* kit.addRows(created.dataSourceId, [{ title: "Row" }]);
          const rowId = made.rows[0]!.pageId;
          yield* Effect.all(
            [
              kit.setCells(created.dataSourceId, rowId, { [points]: 3 }),
              kit.setCells(created.dataSourceId, rowId, { [note]: "https://a.example" }),
            ],
            { concurrency: "unbounded" },
          );
          assert.deepEqual((yield* kit.row(rowId)).row.cells, {
            title: "Row",
            [points]: 3,
            [note]: "https://a.example",
          });
          yield* kit.setCells(created.dataSourceId, rowId, { [points]: 5 });
          yield* kit.setCells(created.dataSourceId, rowId, { [points]: 8 });
          assert.equal((yield* kit.row(rowId)).row.cells[points], 8);

          // A cell write is not a body change: revisions stay, updated_at moves.
          const before = (yield* service.getPage({ ...env, pageId: rowId })).page;
          yield* TestClock.adjust("5 seconds");
          yield* kit.setCells(created.dataSourceId, rowId, { [points]: 9 });
          const after = (yield* service.getPage({ ...env, pageId: rowId })).page;
          assert.equal(after.revision, before.revision);
          assert.notEqual(after.updatedAt, before.updatedAt);
          const pages = yield* raw(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql`SELECT body_revision FROM spaces_pages WHERE page_id = ${rowId}`;
            }),
          );
          assert.deepEqual(pages, [{ body_revision: 0 }]);
          // An editor session that read the body before the cell write still saves.
          const saved = yield* service.applyBlockBatch({
            ...common,
            mutationId: "editor-after-cells",
            pageId: rowId,
            baseRevision: before.revision,
            generation: 0,
            mutations: [{ kind: "insert", block: block("late", 1) }],
          });
          assert.equal(saved.status, "saved");
        }),
      ),
  );

  it.effect("replays row writes by mutation id and refuses a reused id with other input", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Tasks", {
          appendToPageId: page.id,
          properties: [{ name: "Points", type: "number" }],
        });
        const points = created.propertyIds[0]!;
        const input = {
          ...common,
          mutationId: C.SpaceMutationId.make("replayed-create"),
          dataSourceId: created.dataSourceId,
          rows: [{ title: "Once", cells: { [points]: 1 } }],
        };
        const first = yield* service.createRows(input);
        assert.deepEqual(yield* service.createRows(input), first);
        const update = {
          ...common,
          mutationId: C.SpaceMutationId.make("replayed-update"),
          dataSourceId: created.dataSourceId,
          rows: [{ pageId: first.rows[0]!.pageId, cells: { [points]: 2 } }],
        };
        const second = yield* service.updateRows(update);
        yield* kit.setCells(created.dataSourceId, first.rows[0]!.pageId, { [points]: 7 });
        // The replay returns the stored receipt and does not rewrite the newer value.
        assert.deepEqual(yield* service.updateRows(update), second);
        assert.equal((yield* kit.row(first.rows[0]!.pageId)).row.cells[points], 7);
        const counts = yield* raw(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT row_count FROM spaces_db_data_sources`;
          }),
        );
        assert.deepEqual(counts, [{ row_count: 1 }]);
        const reused = yield* Effect.flip(
          service.createRows({ ...input, rows: [{ title: "Different" }] }),
        );
        assert.equal(reused._tag, "SpaceMutationIdMismatchError");
      }),
    ),
  );

  it.effect("round-trips every stored cell type and rejects bad values", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Everything", {
          appendToPageId: page.id,
          properties: [
            { name: "Text", type: "text" },
            { name: "Number", type: "number" },
            {
              name: "Select",
              type: "select",
              options: [
                { id: oid("opta"), name: "A" },
                { id: oid("optb"), name: "B" },
              ],
            },
            {
              name: "Multi",
              type: "multi_select",
              options: [
                { id: oid("opta"), name: "A" },
                { id: oid("optb"), name: "B" },
              ],
            },
            { name: "Status", type: "status" },
            { name: "Date", type: "date" },
            { name: "Checkbox", type: "checkbox" },
            { name: "Url", type: "url" },
            { name: "Email", type: "email" },
            { name: "Phone", type: "phone" },
            { name: "Files", type: "files" },
            { name: "Created", type: "created_time" },
            { name: "Edited", type: "last_edited_time" },
            { name: "Ticket", type: "unique_id", config: { prefix: "TSK" } },
            { name: "Formula", type: "formula", config: { expression: "1" } },
          ],
        });
        const ids = Object.fromEntries(
          [
            "text",
            "number",
            "select",
            "multi",
            "status",
            "date",
            "checkbox",
            "url",
            "email",
            "phone",
            "files",
            "created",
            "edited",
            "ticket",
            "formula",
          ].map((key, i) => [key, created.propertyIds[i]!]),
        );
        const statusOption = (yield* kit.get(created.databaseId)).dataSources[0]!.properties[
          ids.status!
        ]!.config as {
          options: { id: string }[];
        };
        const done = oid(statusOption.options[2]!.id);
        const row = (yield* kit.addRows(created.dataSourceId, [{ title: "Subject" }])).rows[0]!;
        const cases: readonly (readonly [string, C.SpaceCellValue, C.SpaceCellValue])[] = [
          ["text", run("hello"), run("hello")],
          ["number", 4.5, 4.5],
          ["select", "optb", "optb"],
          ["multi", ["optb", "opta"], ["optb", "opta"]],
          ["status", done, done],
          [
            "date",
            { start: "2026-11-11", end: "2026-11-12" },
            { start: "2026-11-11", end: "2026-11-12" },
          ],
          [
            "date",
            { start: "2026-11-11T09:30:00", timeZone: "Asia/Kolkata" },
            { start: "2026-11-11T09:30:00", timeZone: "Asia/Kolkata" },
          ],
          ["checkbox", true, true],
          ["url", "  https://example.com  ", "https://example.com"],
          ["email", "a@b.c", "a@b.c"],
          ["phone", "+1 555", "+1 555"],
          [
            "files",
            [{ name: "Spec", url: "https://example.com/spec.pdf" }],
            [{ name: "Spec", url: "https://example.com/spec.pdf" }],
          ],
        ];
        for (const [key, value, expected] of cases) {
          yield* kit.setCells(created.dataSourceId, row.pageId, { [ids[key]!]: value });
          assert.deepEqual((yield* kit.row(row.pageId)).row.cells[ids[key]!], expected, key);
        }
        const cells = (yield* kit.row(row.pageId)).row.cells;
        assert.deepEqual(cells[ids.ticket!], { number: 1, prefix: "TSK" });
        assert.equal(typeof cells[ids.created!], "string");
        assert.equal(typeof cells[ids.edited!], "string");
        assert.deepEqual(cells[ids.formula!], { type: "number", value: 1 });
        // Every empty form deletes the cell.
        const empties: readonly (readonly [string, C.SpaceCellValue | null])[] = [
          ["text", []],
          ["text", run("")],
          ["number", null],
          ["select", null],
          ["multi", []],
          ["checkbox", false],
          ["url", "   "],
          ["files", []],
        ];
        for (const [key, value] of empties) {
          yield* kit.setCells(created.dataSourceId, row.pageId, { [ids[key]!]: value });
          assert.isUndefined((yield* kit.row(row.pageId)).row.cells[ids[key]!], key);
        }
        const invalid: readonly (readonly [string, C.SpaceCellValue, string])[] = [
          ["text", "plain", "invalid_value"],
          ["text", [{ text: "x", marks: [{ type: "mystery", version: 1 }] }], "invalid_value"],
          ["number", "4", "invalid_value"],
          ["select", "nope", "unknown_option"],
          ["multi", ["opta", "opta"], "invalid_value"],
          ["multi", ["opta", "zzzz"], "unknown_option"],
          ["date", { start: "2026-02-30" }, "invalid_value"],
          ["date", { start: "2026-11-11T09:30:00" }, "invalid_value"],
          ["date", { start: "2026-11-11", end: "2026-11-10" }, "invalid_value"],
          ["date", { start: "2026-11-11", end: "2026-11-12T00:00:00Z" }, "invalid_value"],
          ["date", { start: "2026-11-11", timeZone: "Nowhere/Land" }, "invalid_value"],
          ["checkbox", "yes", "invalid_value"],
          ["files", [{ name: "x", url: "ftp://example.com/x" }], "invalid_value"],
          ["files", [{ name: "x", assetId: "asset" }], "unsupported"],
          ["created", iso, "read_only_property"],
          ["edited", iso, "read_only_property"],
          ["ticket", 5, "read_only_property"],
          ["formula", "1", "read_only_property"],
        ];
        for (const [key, value, reason] of invalid) {
          const error = yield* databaseError(
            kit.setCells(created.dataSourceId, row.pageId, { [ids[key]!]: value }),
          );
          assert.equal(error.reason, reason, key);
          assert.equal(error.propertyId, ids[key], key);
        }
        const missing = yield* Effect.flip(
          kit.setCells(created.dataSourceId, row.pageId, { nonexist: 1 }),
        );
        assert.equal(missing._tag, "SpaceNotFoundError");
        const stranger = yield* Effect.flip(
          kit.setCells(created.dataSourceId, C.SpacePageId.make("not-a-row"), { [ids.number!]: 1 }),
        );
        assert.equal(stranger._tag, "SpaceNotFoundError");
      }),
    ),
  );

  it.effect("applies a status default and orders new rows after existing ones", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Board", {
          appendToPageId: page.id,
          properties: [{ name: "State", type: "status" }],
        });
        const state = created.propertyIds[0]!;
        const made = yield* kit.addRows(created.dataSourceId, [{ title: "a" }, { title: "b" }]);
        const first = yield* kit.row(made.rows[0]!.pageId);
        const defaults = (yield* kit.get(created.databaseId)).dataSources[0]!.properties[state]!
          .config as { options: { id: string }[]; defaultOptionId: string };
        assert.equal(first.row.cells[state], defaults.defaultOptionId);
        assert.deepEqual(
          made.rows.map((row) => row.number),
          [1, 2],
        );
        const third = yield* kit.addRows(
          created.dataSourceId,
          [{ title: "c" }],
          made.rows[0]!.pageId,
        );
        assert.equal(third.rows[0]!.number, 3);
        assert.deepEqual(yield* rowOrder(dbPath, created.dataSourceId), ["c", "a", "b"]);
        yield* service.moveRows({
          ...common,
          mutationId: "move-rows",
          dataSourceId: created.dataSourceId,
          pageIds: [made.rows[1]!.pageId],
          beforeRowId: made.rows[0]!.pageId,
        });
        assert.deepEqual(yield* rowOrder(dbPath, created.dataSourceId), ["c", "b", "a"]);
        const strangerMove = yield* Effect.flip(
          service.moveRows({
            ...common,
            mutationId: "move-stranger",
            dataSourceId: created.dataSourceId,
            pageIds: [page.id],
            beforeRowId: null,
          }),
        );
        assert.equal(strangerMove._tag, "SpaceDatabaseError");
      }),
    ),
  );

  it.effect("keeps templates out of ordinary rows and clears a purged default template", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Templated", { appendToPageId: page.id });
        const made = yield* kit.addRows(created.dataSourceId, [
          { title: "Template", asTemplate: true },
          { title: "Plain" },
        ]);
        const [template, plain] = made.rows.map((row) => row.pageId) as [
          C.SpacePageId,
          C.SpacePageId,
        ];
        const notTemplate = yield* databaseError(
          service.updateDataSource({
            ...common,
            mutationId: "default-plain",
            dataSourceId: created.dataSourceId,
            defaultTemplateId: plain,
          }),
        );
        assert.equal(notTemplate.reason, "not_a_row");
        yield* service.updateDataSource({
          ...common,
          mutationId: "default-template",
          dataSourceId: created.dataSourceId,
          defaultTemplateId: template,
        });
        assert.equal(
          (yield* kit.get(created.databaseId)).dataSources[0]!.defaultTemplateId,
          template,
        );
        yield* service.trashPage(
          yield* recoveryIntent(service, common, template, "trash", "trash-template"),
        );
        yield* service.permanentlyDeletePage(
          yield* recoveryIntent(service, common, template, "permanentlyDelete", "purge-template"),
        );
        const after = (yield* kit.get(created.databaseId)).dataSources[0]!;
        assert.isUndefined(after.defaultTemplateId);
        assert.deepEqual(after.templates, []);
      }),
    ),
  );

  it.effect("renumbers manual order when the gap before a row is used up", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Ordered", { appendToPageId: page.id });
        let head = (yield* kit.addRows(created.dataSourceId, [{ title: "r0" }])).rows[0]!.pageId;
        for (let i = 1; i <= 20; i++)
          head = (yield* kit.addRows(created.dataSourceId, [{ title: `r${i}` }], head)).rows[0]!
            .pageId;
        assert.deepEqual(
          yield* rowOrder(dbPath, created.dataSourceId),
          Array.from({ length: 21 }, (_, i) => `r${20 - i}`),
        );
      }),
    ),
  );

  it.effect("enforces the row and cell limits", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Limits", {
          appendToPageId: page.id,
          properties: [
            { name: "Text", type: "text" },
            {
              name: "Multi",
              type: "multi_select",
              options: Array.from({ length: 101 }, (_, i) => ({
                id: oid(`o${String(i).padStart(3, "0")}x`),
                name: `Option ${i}`,
              })),
            },
          ],
        });
        const [text, multi] = created.propertyIds as [C.SpacePropertyId, C.SpacePropertyId];
        const row = (yield* kit.addRows(created.dataSourceId, [{ title: "r" }])).rows[0]!;
        assert.equal(
          yield* limitError(
            kit.addRows(
              created.dataSourceId,
              Array.from({ length: 101 }, () => ({})),
            ),
          ),
          "databases.maxRowsPerMutation",
        );
        const keys = Object.fromEntries(
          Array.from({ length: 84 }, (_, i) => [`p${String(i).padStart(4, "0")}`, null]),
        );
        assert.equal(
          yield* limitError(
            service.updateRows({
              ...common,
              mutationId: "too-many-cells",
              dataSourceId: created.dataSourceId,
              rows: Array.from({ length: 6 }, () => ({ pageId: row.pageId, cells: keys })),
            }),
          ),
          "databases.maxCellsPerMutation",
        );
        assert.equal(
          yield* limitError(
            kit.setCells(created.dataSourceId, row.pageId, { [text]: run("x".repeat(16_385)) }),
          ),
          "databases.maxCellTextBytes",
        );
        assert.equal(
          yield* limitError(
            kit.setCells(created.dataSourceId, row.pageId, {
              [multi]: Array.from({ length: 101 }, (_, i) => `o${String(i).padStart(3, "0")}x`),
            }),
          ),
          "databases.maxCellItems",
        );
        yield* exec(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE spaces_db_data_sources SET row_count = 25000`;
          }),
        );
        assert.equal(
          yield* limitError(kit.addRows(created.dataSourceId, [{ title: "one too many" }])),
          "databases.maxRowsPerDataSource",
        );
        const untouched = yield* raw(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT row_count FROM spaces_db_data_sources`;
          }),
        );
        assert.deepEqual(untouched, [{ row_count: 25_000 }]);
      }),
    ),
  );
});
