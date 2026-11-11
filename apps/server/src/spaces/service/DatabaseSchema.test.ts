import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { boot, fixture } from "./Spaces.testkit.ts";
import { cellRows, databaseError, databaseKit, limitError, oid, pid } from "./Databases.testkit.ts";

const run = (text: string) => [{ text, marks: [] }];
type Config = { options: { id: string; name: string; group?: string }[]; defaultOptionId?: string };

const setup = Effect.fn("DatabaseSchemaTest.setup")(function* (
  properties: readonly C.SpacePropertyDraft[] = [],
) {
  const { service, common, page } = yield* boot();
  const kit = databaseKit(service, common, page.spaceId);
  const created = yield* kit.create("Schema", { appendToPageId: page.id, properties });
  return { service, common, page, kit, created };
});

it.layer(NodeServices.layer)("Spaces database schema", (it) => {
  it.effect(
    "renames without touching cells and refuses duplicate names across case and accents",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { kit, created } = yield* setup([
            { name: "Étage", type: "number" },
            { name: "Other", type: "text" },
          ]);
          const [floor, other] = created.propertyIds as [C.SpacePropertyId, C.SpacePropertyId];
          const row = (yield* kit.addRows(created.dataSourceId, [{ cells: { [floor]: 3 } }]))
            .rows[0]!;
          const before = yield* cellRows(dbPath, row.pageId, floor);
          yield* kit.schema(created.dataSourceId, [
            { op: "updateProperty", propertyId: floor, name: "Level", description: "Which floor" },
          ]);
          assert.deepEqual(yield* cellRows(dbPath, row.pageId, floor), before);
          const properties = (yield* kit.get(created.databaseId)).dataSources[0]!.properties;
          assert.equal(properties[floor]!.name, "Level");
          assert.equal(properties[floor]!.description, "Which floor");
          for (const name of ["level", "LEVEL", "Name", "name"]) {
            const error = yield* databaseError(
              kit.schema(created.dataSourceId, [{ op: "updateProperty", propertyId: other, name }]),
            );
            assert.equal(error.reason, "duplicate_name");
          }
          const accent = yield* databaseError(
            kit.schema(created.dataSourceId, [
              { op: "updateProperty", propertyId: other, name: "Lévél" },
            ]),
          );
          assert.equal(accent.reason, "duplicate_name");
          const title = yield* databaseError(
            kit.schema(created.dataSourceId, [{ op: "removeProperty", propertyId: pid("title") }]),
          );
          assert.equal(title.reason, "title_property");
          const retype = yield* databaseError(
            kit.schema(created.dataSourceId, [
              { op: "changePropertyType", propertyId: pid("title"), type: "text" },
            ]),
          );
          assert.equal(retype.reason, "title_property");
          const second = yield* databaseError(
            kit.schema(created.dataSourceId, [
              { op: "addProperty", property: { name: "Again", type: "title" } },
            ]),
          );
          assert.equal(second.reason, "title_property");
        }),
      ),
  );

  it.effect("removes a property softly, strips it from views, and restores it with its cells", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, kit, created } = yield* setup([
          { name: "Points", type: "number" },
          { name: "Tag", type: "select", options: [{ id: oid("aaaa"), name: "A" }] },
        ]);
        const [points, tag] = created.propertyIds as [C.SpacePropertyId, C.SpacePropertyId];
        const row = (yield* kit.addRows(created.dataSourceId, [
          { cells: { [points]: 7, [tag]: "aaaa" } },
        ])).rows[0]!;
        yield* service.updateView({
          ...common,
          mutationId: "view-with-points",
          viewId: created.viewId,
          filter: {
            and: [
              { property: points, operator: "greater_than", value: 1 },
              { or: [{ property: tag, operator: "equals", value: "aaaa" }] },
            ],
          },
          sorts: [
            { property: points, direction: "ascending" },
            { property: tag, direction: "descending" },
          ],
          group: { property: tag, by: "option" },
          properties: { set: { [points]: { visible: true, width: 120, aggregate: "sum" } } },
        });
        const removed = yield* kit.schema(created.dataSourceId, [
          { op: "removeProperty", propertyId: points },
        ]);
        assert.deepEqual(removed.affectedDataSourceIds, [created.dataSourceId]);
        let got = yield* kit.get(created.databaseId);
        assert.isUndefined(got.dataSources[0]!.properties[points]);
        assert.deepEqual(
          got.dataSources[0]!.deletedProperties.map((property) => property.id),
          [points],
        );
        const view = got.views[0]!;
        assert.deepEqual(view.filter, {
          and: [{ or: [{ property: tag, operator: "equals", value: "aaaa" }] }],
        });
        assert.deepEqual(view.sorts, [{ property: tag, direction: "descending" }]);
        assert.deepEqual(view.group?.property, tag);
        assert.isFalse(view.properties.some((column) => column.propertyId === points));
        const gone = yield* Effect.flip(
          kit.setCells(created.dataSourceId, row.pageId, { [points]: 1 }),
        );
        assert.equal(gone._tag, "SpaceNotFoundError");
        assert.isUndefined((yield* kit.row(row.pageId)).row.cells[points]);
        yield* kit.schema(created.dataSourceId, [{ op: "restoreProperty", propertyId: points }]);
        got = yield* kit.get(created.databaseId);
        assert.isDefined(got.dataSources[0]!.properties[points]);
        assert.equal((yield* kit.row(row.pageId)).row.cells[points], 7);
        // A name taken in the meantime gets the smallest free suffix on restore.
        yield* kit.schema(created.dataSourceId, [
          { op: "removeProperty", propertyId: points },
          { op: "addProperty", property: { name: "Points", type: "text" } },
          { op: "restoreProperty", propertyId: points },
        ]);
        const renamed = (yield* kit.get(created.databaseId)).dataSources[0]!.properties[points]!;
        assert.equal(renamed.name, "Points (1)");
      }),
    ),
  );

  it.effect(
    "purges the oldest deleted property when more than the retained number are deleted",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { kit, created } = yield* setup(
            Array.from({ length: 52 }, (_, i) => ({ name: `Field ${i}`, type: "number" as const })),
          );
          const ids = created.propertyIds;
          const row = (yield* kit.addRows(created.dataSourceId, [
            { cells: { [ids[0]!]: 0, [ids[1]!]: 1, [ids[2]!]: 2 } },
          ])).rows[0]!;
          yield* kit.schema(
            created.dataSourceId,
            ids.slice(0, 30).map((propertyId) => ({ op: "removeProperty" as const, propertyId })),
          );
          yield* TestClock.adjust("1 second");
          yield* kit.schema(
            created.dataSourceId,
            ids.slice(30).map((propertyId) => ({ op: "removeProperty" as const, propertyId })),
          );
          const deleted = (yield* kit.get(created.databaseId)).dataSources[0]!.deletedProperties;
          assert.lengthOf(deleted, 50);
          assert.isFalse(
            deleted.some((property) => property.id === ids[0] || property.id === ids[1]),
          );
          assert.lengthOf(yield* cellRows(dbPath, row.pageId, ids[0]!), 0);
          assert.lengthOf(yield* cellRows(dbPath, row.pageId, ids[1]!), 0);
          assert.lengthOf(yield* cellRows(dbPath, row.pageId, ids[2]!), 1);
        }),
      ),
  );

  it.effect("manages options: add, rename, reorder, remove clears cells and view conditions", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, kit, created } = yield* setup([
          { name: "Stage", type: "status" },
          {
            name: "Tag",
            type: "select",
            options: [
              { id: oid("aaaa"), name: "A" },
              { id: oid("bbbb"), name: "B" },
            ],
          },
        ]);
        const [stage, tag] = created.propertyIds as [C.SpacePropertyId, C.SpacePropertyId];
        const rows = (yield* kit.addRows(created.dataSourceId, [
          { cells: { [tag]: "aaaa" } },
          { cells: { [tag]: "bbbb" } },
        ])).rows;
        yield* service.updateView({
          ...common,
          mutationId: "tag-filter",
          viewId: created.viewId,
          filter: {
            or: [
              { property: tag, operator: "equals", value: "aaaa" },
              { property: tag, operator: "equals", value: "bbbb" },
            ],
          },
        });
        const added = yield* kit.schema(created.dataSourceId, [
          {
            op: "addOption",
            propertyId: tag,
            option: { name: "C", color: "red" },
            beforeOptionId: oid("aaaa"),
          },
        ]);
        const addedId = added.created[0]!.optionId!;
        const read = async () => 0;
        void read;
        let config = (yield* kit.get(created.databaseId)).dataSources[0]!.properties[tag]!
          .config as Config;
        assert.deepEqual(
          config.options.map((option) => option.name),
          ["C", "A", "B"],
        );
        yield* kit.schema(created.dataSourceId, [
          {
            op: "updateOption",
            propertyId: tag,
            optionId: oid("aaaa"),
            name: "Alpha",
            color: "blue",
          },
          { op: "moveOption", propertyId: tag, optionId: addedId, beforeOptionId: null },
        ]);
        config = (yield* kit.get(created.databaseId)).dataSources[0]!.properties[tag]!
          .config as Config;
        assert.deepEqual(
          config.options.map((option) => option.name),
          ["Alpha", "B", "C"],
        );
        assert.equal((yield* kit.row(rows[0]!.pageId)).row.cells[tag], "aaaa");
        const duplicate = yield* databaseError(
          kit.schema(created.dataSourceId, [
            { op: "addOption", propertyId: tag, option: { name: "alpha" } },
          ]),
        );
        assert.equal(duplicate.reason, "duplicate_name");
        const grouped = yield* databaseError(
          kit.schema(created.dataSourceId, [
            { op: "addOption", propertyId: tag, option: { name: "Z", group: "todo" } },
          ]),
        );
        assert.equal(grouped.reason, "invalid_property_config");
        const removal = yield* kit.schema(created.dataSourceId, [
          { op: "removeOption", propertyId: tag, optionId: oid("aaaa") },
        ]);
        assert.equal(removal.clearedCells, 1);
        assert.isUndefined((yield* kit.row(rows[0]!.pageId)).row.cells[tag]);
        assert.equal((yield* kit.row(rows[1]!.pageId)).row.cells[tag], "bbbb");
        const view = (yield* kit.get(created.databaseId)).views[0]!;
        assert.deepEqual(view.filter, {
          or: [{ property: tag, operator: "equals", value: "bbbb" }],
        });
        // A status keeps at least one option and unsets a removed default.
        const stageConfig = (yield* kit.get(created.databaseId)).dataSources[0]!.properties[stage]!
          .config as Config;
        assert.deepEqual(
          stageConfig.options.map((option) => option.group),
          ["todo", "in_progress", "complete"],
        );
        const first = stageConfig.options[0]!.id;
        yield* kit.schema(created.dataSourceId, [
          { op: "removeOption", propertyId: stage, optionId: oid(first) },
        ]);
        const after = (yield* kit.get(created.databaseId)).dataSources[0]!.properties[stage]!
          .config as Config;
        assert.isUndefined(after.defaultOptionId);
        const rest = after.options.map((option) => option.id);
        yield* kit.schema(created.dataSourceId, [
          { op: "removeOption", propertyId: stage, optionId: oid(rest[0]!) },
        ]);
        const last = yield* databaseError(
          kit.schema(created.dataSourceId, [
            { op: "removeOption", propertyId: stage, optionId: oid(rest[1]!) },
          ]),
        );
        assert.equal(last.reason, "last_option");
        const missing = yield* Effect.flip(
          kit.schema(created.dataSourceId, [
            { op: "removeOption", propertyId: tag, optionId: oid("nope") },
          ]),
        );
        assert.equal(missing._tag, "SpaceNotFoundError");
      }),
    ),
  );

  it.effect(
    "applies operations on different properties and replays a schema edit by mutation id",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, common, kit, created } = yield* setup([
            { name: "One", type: "text" },
            { name: "Two", type: "text" },
          ]);
          const [one, two] = created.propertyIds as [C.SpacePropertyId, C.SpacePropertyId];
          yield* Effect.all(
            [
              kit.schema(created.dataSourceId, [
                { op: "updateProperty", propertyId: one, name: "Uno" },
              ]),
              kit.schema(created.dataSourceId, [
                { op: "updateProperty", propertyId: two, name: "Dos" },
              ]),
            ],
            { concurrency: "unbounded" },
          );
          const names = Object.values(
            (yield* kit.get(created.databaseId)).dataSources[0]!.properties,
          ).map((property) => property.name);
          assert.sameMembers(names, ["Name", "Uno", "Dos"]);
          const input = {
            ...common,
            mutationId: C.SpaceMutationId.make("add-once"),
            dataSourceId: created.dataSourceId,
            operations: [
              { op: "addProperty" as const, property: { name: "Extra", type: "number" as const } },
            ],
          };
          const first = yield* service.updateSchema(input);
          assert.deepEqual(yield* service.updateSchema(input), first);
          const count = Object.keys(
            (yield* kit.get(created.databaseId)).dataSources[0]!.properties,
          ).length;
          assert.equal(count, 4);
          assert.equal(first.created[0]?.index, 0);
        }),
      ),
  );

  it.effect("converts values when a property changes type, per the conversion matrix", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, created } = yield* setup();
        const rowIds = (yield* kit.addRows(created.dataSourceId, [{}, {}, {}, {}])).rows.map(
          (row) => row.pageId,
        );
        interface Case {
          readonly name: string;
          readonly from: C.SpacePropertyDraft;
          readonly to: C.SpacePropertyType;
          readonly values: readonly (C.SpaceCellValue | undefined)[];
          readonly expected: readonly (C.SpaceCellValue | undefined)[];
          readonly cleared: number;
        }
        const date = { start: "2026-11-11", end: "2026-11-12" };
        const cases: readonly Case[] = [
          {
            name: "text to url trims",
            from: { name: "c1", type: "text" },
            to: "url",
            values: [run("  https://a.b  "), run("x"), run(""), undefined],
            expected: ["https://a.b", "x", undefined, undefined],
            cleared: 0,
          },
          {
            name: "url to text",
            from: { name: "c2", type: "url" },
            to: "text",
            values: ["https://a.b", undefined, undefined, undefined],
            expected: [run("https://a.b"), undefined, undefined, undefined],
            cleared: 0,
          },
          {
            name: "text to number",
            from: { name: "c3", type: "text" },
            to: "number",
            values: [run("1,234.5"), run("-3e2"), run("abc"), run("  ")],
            expected: [1234.5, -300, undefined, undefined],
            cleared: 1,
          },
          {
            name: "text to select reuses and creates",
            from: { name: "c4", type: "text" },
            to: "select",
            values: [run("Red"), run("red"), run("Blue"), undefined],
            expected: ["@red", "@red", "@blue", undefined],
            cleared: 0,
          },
          {
            name: "text to multi_select splits",
            from: { name: "c5", type: "text" },
            to: "multi_select",
            values: [run("a, b ,, a"), run("b"), undefined, undefined],
            expected: [["@a", "@b"], ["@b"], undefined, undefined],
            cleared: 0,
          },
          {
            name: "text to status reuses only",
            from: { name: "c6", type: "text" },
            to: "status",
            values: [run("Done"), run("In progress"), run("Nope"), undefined],
            expected: ["@done", "@in progress", undefined, undefined],
            cleared: 1,
          },
          {
            name: "text to checkbox",
            from: { name: "c7", type: "text" },
            to: "checkbox",
            values: [run("Yes"), run("1"), run("no"), undefined],
            expected: [true, true, undefined, undefined],
            cleared: 0,
          },
          {
            name: "text to date",
            from: { name: "c8", type: "text" },
            to: "date",
            values: [run("2026-11-11"), run("2026-11-11T10:00:00Z"), run("soon"), undefined],
            expected: [
              { start: "2026-11-11" },
              { start: "2026-11-11T10:00:00Z" },
              undefined,
              undefined,
            ],
            cleared: 1,
          },
          {
            name: "number to text",
            from: { name: "c9", type: "number" },
            to: "text",
            values: [5, 0.5, undefined, undefined],
            expected: [run("5"), run("0.5"), undefined, undefined],
            cleared: 0,
          },
          {
            name: "number to checkbox",
            from: { name: "c10", type: "number" },
            to: "checkbox",
            values: [5, 0, undefined, undefined],
            expected: [true, undefined, undefined, undefined],
            cleared: 0,
          },
          {
            name: "number to select",
            from: { name: "c11", type: "number" },
            to: "select",
            values: [5, undefined, undefined, undefined],
            expected: ["@5", undefined, undefined, undefined],
            cleared: 0,
          },
          {
            name: "select to multi_select",
            from: { name: "c12", type: "select", options: [{ id: oid("ssss"), name: "S" }] },
            to: "multi_select",
            values: ["ssss", undefined, undefined, undefined],
            expected: [["ssss"], undefined, undefined, undefined],
            cleared: 0,
          },
          {
            name: "multi_select to select keeps the first",
            from: {
              name: "c13",
              type: "multi_select",
              options: [
                { id: oid("mmmm"), name: "M" },
                { id: oid("nnnn"), name: "N" },
              ],
            },
            to: "select",
            values: [["nnnn", "mmmm"], undefined, undefined, undefined],
            expected: ["nnnn", undefined, undefined, undefined],
            cleared: 0,
          },
          {
            name: "select to status carries options as todo",
            from: { name: "c14", type: "select", options: [{ id: oid("tttt"), name: "T" }] },
            to: "status",
            values: ["tttt", undefined, undefined, undefined],
            expected: ["tttt", undefined, undefined, undefined],
            cleared: 0,
          },
          {
            name: "status to select",
            from: {
              name: "c15",
              type: "status",
              options: [{ id: oid("uuuu"), name: "U", group: "complete" }],
            },
            to: "select",
            values: ["uuuu", undefined, undefined, undefined],
            expected: ["uuuu", undefined, undefined, undefined],
            cleared: 0,
          },
          {
            name: "select to text joins names",
            from: {
              name: "c16",
              type: "multi_select",
              options: [
                { id: oid("vvvv"), name: "V" },
                { id: oid("wwww"), name: "W" },
              ],
            },
            to: "text",
            values: [["vvvv", "wwww"], undefined, undefined, undefined],
            expected: [run("V, W"), undefined, undefined, undefined],
            cleared: 0,
          },
          {
            name: "select to number parses names",
            from: {
              name: "c17",
              type: "select",
              options: [
                { id: oid("xxxx"), name: "42" },
                { id: oid("yyyy"), name: "forty" },
              ],
            },
            to: "number",
            values: ["xxxx", "yyyy", undefined, undefined],
            expected: [42, undefined, undefined, undefined],
            cleared: 1,
          },
          {
            name: "checkbox to text",
            from: { name: "c18", type: "checkbox" },
            to: "text",
            values: [true, false, undefined, undefined],
            expected: [run("Yes"), undefined, undefined, undefined],
            cleared: 0,
          },
          {
            name: "checkbox to number",
            from: { name: "c19", type: "checkbox" },
            to: "number",
            values: [true, undefined, undefined, undefined],
            expected: [1, undefined, undefined, undefined],
            cleared: 0,
          },
          {
            name: "date to text",
            from: { name: "c20", type: "date" },
            to: "text",
            values: [date, { start: "2026-01-02" }, undefined, undefined],
            expected: [run("2026-11-11 → 2026-11-12"), run("2026-01-02"), undefined, undefined],
            cleared: 0,
          },
          {
            name: "date to number clears",
            from: { name: "c21", type: "date" },
            to: "number",
            values: [date, undefined, undefined, undefined],
            expected: [undefined, undefined, undefined, undefined],
            cleared: 1,
          },
          {
            name: "number to date clears",
            from: { name: "c22", type: "number" },
            to: "date",
            values: [1, 2, undefined, undefined],
            expected: [undefined, undefined, undefined, undefined],
            cleared: 2,
          },
          {
            name: "files to text clears",
            from: { name: "c23", type: "files" },
            to: "text",
            values: [[{ name: "f", url: "https://f.example" }], undefined, undefined, undefined],
            expected: [undefined, undefined, undefined, undefined],
            cleared: 1,
          },
        ];
        for (const entry of cases) {
          const added = yield* kit.schema(created.dataSourceId, [
            { op: "addProperty", property: entry.from },
          ]);
          const id = added.created[0]!.propertyId!;
          for (const [i, value] of entry.values.entries())
            if (value !== undefined)
              yield* kit.setCells(created.dataSourceId, rowIds[i]!, { [id]: value });
          const result = yield* kit.schema(created.dataSourceId, [
            { op: "changePropertyType", propertyId: id, type: entry.to },
          ]);
          assert.equal(result.clearedCells, entry.cleared, entry.name);
          const property = (yield* kit.get(created.databaseId)).dataSources[0]!.properties[id]!;
          assert.equal(property.type, entry.to, entry.name);
          const names = new Map(
            ((property.config as Config).options ?? []).map((option) => [
              `@${option.name.toLowerCase()}`,
              option.id,
            ]),
          );
          for (const [i, expected] of entry.expected.entries()) {
            const actual = (yield* kit.row(rowIds[i]!)).row.cells[id];
            const resolved =
              typeof expected === "string" && expected.startsWith("@")
                ? names.get(expected)
                : Array.isArray(expected) &&
                    expected.every((item) => typeof item === "string" && item.startsWith("@"))
                  ? expected.map((item) => names.get(String(item)))
                  : expected;
            assert.deepEqual(actual, resolved, `${entry.name} row ${i}`);
          }
        }
      }),
    ),
  );

  it.effect(
    "rejects conversions to or from the title, to a second unique id, and clears views",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, common, kit, created } = yield* setup([
            { name: "Ticket", type: "unique_id" },
            { name: "Score", type: "number" },
          ]);
          const [ticket, score] = created.propertyIds as [C.SpacePropertyId, C.SpacePropertyId];
          const second = yield* databaseError(
            kit.schema(created.dataSourceId, [
              { op: "addProperty", property: { name: "Ticket 2", type: "unique_id" } },
            ]),
          );
          assert.equal(second.reason, "invalid_property_config");
          yield* service.updateView({
            ...common,
            mutationId: "score-view",
            viewId: created.viewId,
            filter: { property: score, operator: "greater_than", value: 1 },
            sorts: [{ property: score, direction: "descending" }],
            group: { property: score, by: { range: { start: 0, size: 10 } } },
            properties: { set: { [score]: { visible: true, aggregate: "sum" } } },
          });
          yield* kit.schema(created.dataSourceId, [
            { op: "changePropertyType", propertyId: score, type: "text" },
          ]);
          const view = (yield* kit.get(created.databaseId)).views[0]!;
          assert.isUndefined(view.filter);
          assert.deepEqual(view.sorts, []);
          assert.isUndefined(view.group);
          const column = view.properties.find((entry) => entry.propertyId === score);
          assert.isTrue(column?.visible);
          assert.isUndefined(column?.aggregate);
          // unique_id numbers are the row sequence, so a re-added property keeps them.
          const row = (yield* kit.addRows(created.dataSourceId, [{}])).rows[0]!;
          yield* kit.schema(created.dataSourceId, [{ op: "removeProperty", propertyId: ticket }]);
          yield* kit.schema(created.dataSourceId, [{ op: "restoreProperty", propertyId: ticket }]);
          assert.deepEqual((yield* kit.row(row.pageId)).row.cells[ticket], { number: row.number });
          const toTitle = yield* databaseError(
            kit.schema(created.dataSourceId, [
              { op: "changePropertyType", propertyId: score, type: "title" },
            ]),
          );
          assert.equal(toTitle.reason, "title_property");
        }),
      ),
  );

  it.effect("validates configs per type and orders properties", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, created } = yield* setup([
          { name: "Cost", type: "number", config: { format: "dollar", decimals: 2 } },
          { name: "Pick", type: "select", options: [{ name: "One" }] },
        ]);
        const [cost, pick] = created.propertyIds as [C.SpacePropertyId, C.SpacePropertyId];
        const properties = (yield* kit.get(created.databaseId)).dataSources[0]!.properties;
        assert.deepEqual(properties[cost]!.config, { format: "dollar", decimals: 2 });
        const invalid: readonly C.SpacePropertyDraft[] = [
          { name: "A", type: "number", config: { format: "dollar", decimals: 11 } },
          { name: "B", type: "text", config: { anything: 1 } },
          { name: "C", type: "unique_id", config: { prefix: "no spaces" } },
          { name: "D", type: "select", config: { options: [] } },
          { name: "E", type: "text", options: [{ name: "x" }] },
          { name: "F", type: "date", config: { dateFormat: "wild" } },
          {
            name: "G",
            type: "status",
            config: { defaultOptionId: "missing" },
            options: [{ name: "x" }],
          },
          {
            name: "H",
            type: "rollup",
            config: { relationPropertyId: cost, targetPropertyId: "title", function: "count_all" },
          },
          { name: "I", type: "text", id: pid("title") },
          { name: "J", type: "text", id: pid("Bad!") },
        ];
        for (const property of invalid)
          assert.equal(
            (yield* databaseError(
              kit.schema(created.dataSourceId, [{ op: "addProperty", property }]),
            )).reason,
            "invalid_property_config",
            property.name,
          );
        const withOptions = yield* databaseError(
          kit.schema(created.dataSourceId, [
            { op: "updateProperty", propertyId: pick, config: { options: [] } },
          ]),
        );
        assert.equal(withOptions.reason, "invalid_property_config");
        const clientId = yield* kit.schema(created.dataSourceId, [
          {
            op: "addProperty",
            property: { name: "Mine", type: "checkbox", id: pid("mine01") },
            beforePropertyId: cost,
          },
        ]);
        assert.equal(clientId.created[0]!.propertyId, "mine01");
        assert.equal(
          (yield* databaseError(
            kit.schema(created.dataSourceId, [
              {
                op: "addProperty",
                property: { name: "Again", type: "checkbox", id: pid("mine01") },
              },
            ]),
          )).reason,
          "invalid_property_config",
        );
        yield* kit.schema(created.dataSourceId, [
          { op: "moveProperty", propertyId: pick, beforePropertyId: pid("mine01") },
        ]);
        const order = Object.values((yield* kit.get(created.databaseId)).dataSources[0]!.properties)
          .sort((a, b) => a.position - b.position)
          .map((property) => property.id);
        assert.deepEqual(order, ["title", pick, "mine01", cost]);
        const missing = yield* Effect.flip(
          kit.schema(created.dataSourceId, [
            { op: "moveProperty", propertyId: pick, beforePropertyId: pid("ghost") },
          ]),
        );
        assert.equal(missing._tag, "SpaceNotFoundError");
      }),
    ),
  );

  it.effect("enforces schema quotas", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        assert.equal(
          yield* limitError(
            kit.create("Wide", {
              properties: Array.from({ length: 100 }, (_, i) => ({
                name: `P${i}`,
                type: "text" as const,
              })),
            }),
          ),
          "databases.maxPropertiesPerDataSource",
        );
        assert.equal(
          yield* limitError(
            kit.create("Tall", {
              properties: [
                {
                  name: "Pick",
                  type: "select",
                  options: Array.from({ length: 201 }, (_, i) => ({ name: `Option ${i}` })),
                },
              ],
            }),
          ),
          "databases.maxOptionsPerProperty",
        );
        const created = yield* kit.create("Quotas", { appendToPageId: page.id });
        assert.equal(
          yield* limitError(
            kit.schema(
              created.dataSourceId,
              Array.from({ length: 51 }, (_, i) => ({
                op: "addProperty" as const,
                property: { name: `N${i}`, type: "text" as const },
              })),
            ),
          ),
          "databases.maxSchemaOperations",
        );
        assert.equal(
          yield* limitError(
            kit.schema(created.dataSourceId, [
              {
                op: "addProperty",
                property: { name: "Long", type: "text", description: "d".repeat(70_000) },
              },
            ]),
          ),
          "databases.maxSchemaBytes",
        );
        const formula = yield* limitError(
          kit.schema(created.dataSourceId, [
            {
              op: "addProperty",
              property: { name: "F", type: "formula", config: { expression: "x".repeat(8_193) } },
            },
          ]),
        );
        assert.equal(formula, "databases.maxFormulaBytes");
        const sources = (yield* kit.get(created.databaseId)).dataSources;
        assert.lengthOf(sources, 1);
      }),
    ),
  );
});
