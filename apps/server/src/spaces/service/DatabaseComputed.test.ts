import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as SqlClient from "effect/sql/SqlClient";

import { fixture } from "./Spaces.testkit.ts";
import { databaseError, pid, raw } from "./Databases.testkit.ts";
import { ids, numberValue, setupWork, stringValue, tags } from "./DatabaseComputed.testkit.ts";

const formula = (expression: string) => ({ expression });

it.layer(NodeServices.layer)("Spaces computed definitions and values", (it) => {
  it.effect("evaluates a formula over stored properties when rows are created and edited", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, tasks, t, addComputed, cell } = yield* setupWork();
        yield* addComputed(
          tasks,
          ids.double.toString(),
          "Double",
          "formula",
          formula('prop("Estimate") * 2'),
        );
        assert.deepEqual(yield* cell(t[0]!, ids.double), numberValue(6));
        assert.deepEqual(yield* cell(t[1]!, ids.double), numberValue(8));
        yield* kit.setCells(tasks, t[0]!, { [ids.est]: 10 });
        assert.deepEqual(yield* cell(t[0]!, ids.double), numberValue(20));
        // A row created later is computed in its own mutation; clearing an input empties the value.
        const [fresh] = (yield* kit.addRows(tasks, [{ title: "T4", cells: { [ids.est]: 1 } }]))
          .rows;
        assert.deepEqual(yield* cell(fresh!.pageId, ids.double), numberValue(2));
        yield* kit.setCells(tasks, fresh!.pageId, { [ids.est]: null });
        assert.isUndefined(yield* cell(fresh!.pageId, ids.double));
      }),
    ),
  );

  it.effect("round-trips each result type through the cell columns and the wire JSON", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, tasks, t, addComputed, cell, property } = yield* setupWork();
        const defs: ReadonlyArray<readonly [string, string, string]> = [
          ["fnum001", "Num", 'prop("Estimate") + 0.5'],
          ["ftxt001", "Text", 'prop("Name") + "!"'],
          ["fbool01", "Bool", 'prop("Estimate") > 3'],
          ["fdate01", "Date", 'dateAdd(prop("Due"), 1, "days")'],
          ["flist01", "List", '[prop("Name"), prop("Tag")]'],
          ["fpage01", "Page", 'prop("Project").first()'],
          ["frich01", "Rich", 'style(prop("Name"), "b")'],
        ];
        for (const [id, name, expression] of defs)
          yield* addComputed(tasks, id, name, "formula", formula(expression));
        const read = (id: string) => cell(t[0]!, pid(id));
        assert.deepEqual(yield* read("fnum001"), numberValue(3.5));
        assert.deepEqual(yield* read("ftxt001"), stringValue("T1!"));
        assert.isUndefined(yield* cell(t[0]!, pid("fbool01")));
        assert.deepEqual(yield* cell(t[1]!, pid("fbool01")), { type: "boolean", value: true });
        assert.deepEqual(yield* read("fdate01"), { type: "date", value: { start: "2026-11-06" } });
        assert.deepEqual(yield* cell(t[1]!, pid("flist01")), {
          type: "array",
          value: [stringValue("T2"), stringValue("Red")],
        });
        const page = yield* read("fpage01");
        assert.equal((page as { type: string }).type, "page");
        const rich = (yield* read("frich01")) as { value: string; runs: unknown[] };
        assert.equal(rich.value, "T1");
        assert.deepEqual(rich.runs, [{ text: "T1", marks: [{ type: "bold", version: 1 }] }]);
        // Result types are reported on the property, with the query type they filter as.
        assert.deepEqual((yield* property(tasks, "fnum001")).computed, {
          resultType: "number",
          queryType: "number",
          inputs: [ids.est],
        });
        assert.equal((yield* property(tasks, "fbool01")).computed?.queryType, "checkbox");
        assert.equal((yield* property(tasks, "fdate01")).computed?.queryType, "date");
        assert.equal((yield* property(tasks, "flist01")).computed?.queryType, "text");
        yield* kit.setCells(tasks, t[0]!, { [ids.due]: null });
        assert.isUndefined(yield* read("fdate01"));
      }),
    ),
  );

  it.effect("cuts long text and long lists to what one cell may hold", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { tasks, t, addComputed, cell } = yield* setupWork();
        yield* addComputed(tasks, "long001", "Long", "formula", formula('"é".repeat(9000)'));
        yield* addComputed(
          tasks,
          "many001",
          "Many",
          "formula",
          formula('"a".repeat(150).split("")'),
        );
        const long = (yield* cell(t[0]!, pid("long001"))) as { type: string; value: string };
        assert.equal(long.type, "string");
        assert.isAbove(long.value.length, 1000);
        assert.isBelow(Buffer.byteLength(JSON.stringify(long), "utf8"), 16_385);
        const many = (yield* cell(t[0]!, pid("many001"))) as {
          type: string;
          value: unknown[];
          truncated?: boolean;
        };
        assert.equal(many.type, "array");
        assert.lengthOf(many.value, 100);
        assert.isTrue(many.truncated);
      }),
    ),
  );

  it.effect("refuses an invalid formula with a positioned detail and keeps the empty one", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, tasks, addComputed } = yield* setupWork();
        const bad = yield* databaseError(
          addComputed(tasks, "bad0001", "Bad", "formula", formula('prop("Nope") + 1')),
        );
        assert.equal(bad.reason, "invalid_property_config");
        assert.equal(bad.propertyId, "bad0001");
        assert.equal(bad.detail, '1:6 There is no property named "Nope".');
        const wrongType = yield* databaseError(
          addComputed(tasks, "bad0002", "Bad2", "formula", formula("\n  if(1, 2, 3)")),
        );
        assert.match(wrongType.detail ?? "", /^2:6 /);
        yield* addComputed(tasks, "empty01", "Empty", "formula", formula("  "));
        // The same refusal applies when an existing formula is edited; the old one stays.
        yield* addComputed(tasks, "ok00001", "Ok", "formula", formula("1"));
        const edit = yield* databaseError(
          kit.schema(tasks, [
            { op: "updateProperty", propertyId: pid("ok00001"), config: formula("1 +") },
          ]),
        );
        assert.equal(edit.reason, "invalid_property_config");
      }),
    ),
  );

  it.effect("renders renamed inputs, strips views, and recovers when an input comes back", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, kit, created, tasks, t, addComputed, cell, property } =
          yield* setupWork();
        yield* addComputed(
          tasks,
          ids.double.toString(),
          "Double",
          "formula",
          formula('prop("Estimate") * 2'),
        );
        yield* service.createView({
          ...common,
          mutationId: "double-view",
          dataSourceId: tasks,
          name: "Doubles",
          type: "table",
          filter: { property: ids.double, operator: "greater_than", value: 6 },
          sorts: [{ property: ids.double, direction: "ascending" }],
        });
        // A rename shows in the rendered source and changes no value; the stored text is untouched.
        yield* kit.schema(tasks, [{ op: "updateProperty", propertyId: ids.est, name: "Effort" }]);
        assert.equal(
          ((yield* property(tasks, ids.double)).config as { expression: string }).expression,
          'prop("Effort") * 2',
        );
        assert.deepEqual(yield* cell(t[0]!, ids.double), numberValue(6));
        const stored = yield* raw(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{
              readonly config: string;
            }>`SELECT config FROM spaces_db_properties WHERE property_id = ${ids.double}`;
          }),
        );
        assert.equal(
          (JSON.parse(stored[0]!.config) as { expression: string }).expression,
          'prop("Estimate") * 2',
        );
        // Deleting the input puts the formula in error: no values, saved views lose their references.
        yield* kit.schema(tasks, [{ op: "removeProperty", propertyId: ids.est }]);
        const broken = yield* property(tasks, ids.double);
        assert.match(broken.computed?.error?.message ?? "", /Effort|deleted/);
        assert.isUndefined(broken.computed?.queryType);
        assert.isUndefined(yield* cell(t[0]!, ids.double));
        const views = (yield* kit.get(created.databaseId)).views.filter(
          (v) => v.name === "Doubles",
        );
        assert.isUndefined(views[0]!.filter);
        assert.deepEqual(views[0]!.sorts ?? [], []);
        // Restoring it recovers the formula and its values.
        yield* kit.schema(tasks, [{ op: "restoreProperty", propertyId: ids.est }]);
        assert.isUndefined((yield* property(tasks, ids.double)).computed?.error);
        assert.deepEqual(yield* cell(t[1]!, ids.double), numberValue(8));
      }),
    ),
  );

  it.effect("strips view references when an edited definition changes its query type", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, kit, created, tasks, addComputed } = yield* setupWork();
        yield* addComputed(
          tasks,
          ids.double.toString(),
          "Double",
          "formula",
          formula('prop("Estimate") * 2'),
        );
        yield* service.createView({
          ...common,
          mutationId: "double-view-edit",
          dataSourceId: tasks,
          name: "Doubles",
          type: "table",
          filter: { property: ids.double, operator: "greater_than", value: 1 },
          sorts: [{ property: ids.double, direction: "ascending" }],
        });
        const doubles = Effect.map(
          kit.get(created.databaseId),
          (database) => database.views.filter((v) => v.name === "Doubles")[0]!,
        );
        // Same query type: the view is kept.
        yield* kit.schema(tasks, [
          { op: "updateProperty", propertyId: ids.double, config: formula('prop("Estimate") * 3') },
        ]);
        assert.isDefined((yield* doubles).filter);
        yield* kit.schema(tasks, [
          {
            op: "updateProperty",
            propertyId: ids.double,
            config: formula('format(prop("Estimate"))'),
          },
        ]);
        const edited = yield* doubles;
        assert.isUndefined(edited.filter);
        assert.deepEqual(edited.sorts ?? [], []);
      }),
    ),
  );

  it.effect("follows a type change of an input and an option rename", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, tasks, t, addComputed, cell, property } = yield* setupWork();
        yield* addComputed(
          tasks,
          ids.double.toString(),
          "Double",
          "formula",
          formula('prop("Estimate") * 2'),
        );
        yield* addComputed(tasks, "tagf001", "TagName", "formula", formula('prop("Tag")'));
        assert.deepEqual(yield* cell(t[1]!, pid("tagf001")), stringValue("Red"));
        yield* kit.schema(tasks, [
          { op: "updateOption", propertyId: ids.tag, optionId: tags.red, name: "Crimson" },
        ]);
        assert.deepEqual(yield* cell(t[1]!, pid("tagf001")), stringValue("Crimson"));
        // number -> text: `text * 2` no longer checks, so the formula is in error and empty.
        yield* kit.schema(tasks, [{ op: "changePropertyType", propertyId: ids.est, type: "text" }]);
        assert.isDefined((yield* property(tasks, ids.double)).computed?.error);
        assert.isUndefined(yield* cell(t[0]!, ids.double));
        yield* kit.schema(tasks, [
          { op: "changePropertyType", propertyId: ids.est, type: "number" },
        ]);
        assert.isUndefined((yield* property(tasks, ids.double)).computed?.error);
        assert.deepEqual(yield* cell(t[0]!, ids.double), numberValue(6));
        // Making the formula something else drops its values; a plain type has no definition.
        yield* kit.schema(tasks, [
          { op: "changePropertyType", propertyId: ids.double, type: "number" },
        ]);
        assert.isUndefined((yield* property(tasks, ids.double)).computed);
        assert.isUndefined(yield* cell(t[0]!, ids.double));
      }),
    ),
  );

  it.effect("rejects cycles within a data source, across databases and through a rollup", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, page, projects, tasks, addComputed } = yield* setupWork();
        yield* addComputed(tasks, "cyca001", "A", "formula", formula("1"));
        yield* addComputed(tasks, "cycb001", "B", "formula", formula('prop("A") + 1'));
        const loop = yield* databaseError(
          kit.schema(tasks, [
            { op: "updateProperty", propertyId: pid("cyca001"), config: formula('prop("B")') },
          ]),
        );
        assert.equal(loop.reason, "cycle");
        assert.equal(loop.detail, "Circular reference: A → B → A");
        const self = yield* databaseError(
          kit.schema(tasks, [
            { op: "updateProperty", propertyId: pid("cycb001"), config: formula('prop("B")') },
          ]),
        );
        assert.equal(self.reason, "cycle");
        // Through a rollup: Projects.R sums Tasks.A while Tasks.A reads Projects.R.
        yield* addComputed(projects, "rollr01", "R", "rollup", {
          relationPropertyId: ids.tasksOf,
          targetPropertyId: "cycb001",
          function: "sum",
        });
        const viaRollup = yield* databaseError(
          kit.schema(tasks, [
            {
              op: "updateProperty",
              propertyId: pid("cyca001"),
              config: formula('prop("Project").first().prop("R")'),
            },
          ]),
        );
        assert.equal(viaRollup.reason, "cycle");
        // Across two databases.
        const other = yield* kit.create("Other", { appendToPageId: page.id });
        const otherSource = other.dataSourceId;
        yield* kit.schema(otherSource, [
          {
            op: "addProperty",
            property: {
              id: pid("olnk001"),
              name: "Link",
              type: "relation",
              config: { dataSourceId: tasks, limit: "many" },
            },
          },
        ]);
        yield* kit.schema(tasks, [
          {
            op: "addProperty",
            property: {
              id: pid("tlnk001"),
              name: "Back",
              type: "relation",
              config: { dataSourceId: otherSource, limit: "many" },
            },
          },
        ]);
        yield* addComputed(
          otherSource,
          "ofrm001",
          "OF",
          "formula",
          formula('prop("Link").length()'),
        );
        yield* addComputed(tasks, "tfrm001", "TF", "formula", formula("1"));
        yield* kit.schema(otherSource, [
          {
            op: "updateProperty",
            propertyId: pid("ofrm001"),
            config: formula('prop("Link").map(current.prop("TF")).length()'),
          },
        ]);
        const across = yield* databaseError(
          kit.schema(tasks, [
            {
              op: "updateProperty",
              propertyId: pid("tfrm001"),
              config: formula('prop("Back").map(current.prop("OF")).length()'),
            },
          ]),
        );
        assert.equal(across.reason, "cycle");
        assert.equal(across.detail, "Circular reference: TF → OF → TF");
      }),
    ),
  );

  it.effect("limits a chain of formulas to 15 layers", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { tasks, addComputed } = yield* setupWork();
        yield* addComputed(tasks, "lay0001", "L1", "formula", formula("1"));
        for (let layer = 2; layer <= 15; layer++)
          yield* addComputed(
            tasks,
            `lay${String(layer).padStart(4, "0")}`,
            `L${layer}`,
            "formula",
            formula(`prop("L${layer - 1}") + 1`),
          );
        const tooDeep = yield* databaseError(
          addComputed(tasks, "lay0016", "L16", "formula", formula('prop("L15") + 1')),
        );
        assert.equal(tooDeep.reason, "invalid_property_config");
        assert.equal(tooDeep.detail, "Too many layers of formulas and rollups (15 at most).");
      }),
    ),
  );

  it.effect(
    "refuses a rollup of a rollup, of a volatile property, and of an illegal function",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { tasks, projects, addComputed } = yield* setupWork();
          yield* addComputed(projects, "rolla01", "Sum", "rollup", {
            relationPropertyId: ids.tasksOf,
            targetPropertyId: ids.est,
            function: "sum",
          });
          yield* addComputed(tasks, "clock01", "Clock", "formula", formula("now()"));
          const roll = (target: string, fn: string) =>
            databaseError(
              addComputed(projects, "rollx01", "X", "rollup", {
                relationPropertyId: ids.tasksOf,
                targetPropertyId: target,
                function: fn,
              }),
            );
          assert.match((yield* roll("clock01", "show_original")).detail ?? "", /now\(\)/);
          assert.equal((yield* roll(ids.est, "earliest_date")).reason, "invalid_property_config");
          assert.equal((yield* roll("ghost01", "sum")).reason, "invalid_property_config");
          // The first rollup is untouched and a rollup of a rollup on the other side is refused.
          yield* addComputed(tasks, "rolla02", "Back", "rollup", {
            relationPropertyId: ids.project,
            targetPropertyId: "rolla01",
            function: "sum",
          }).pipe(
            Effect.flip,
            Effect.map((error) =>
              assert.equal((error as { reason?: string }).reason, "invalid_property_config"),
            ),
          );
        }),
      ),
  );
});
