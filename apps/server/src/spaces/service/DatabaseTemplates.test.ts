import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";

import { block, boot, env, fixture, recoveryIntent } from "./Spaces.testkit.ts";
import {
  databaseError,
  databaseKit,
  limitError,
  pid,
  raw,
  warmSearch,
} from "./Databases.testkit.ts";

const note = pid("note01");
const points = pid("points");
const state = pid("state1");
const project = pid("proj01");
const run = (text: string) => [{ text, marks: [] }];

const setup = Effect.fn("DatabaseTemplatesTest.setup")(function* () {
  const { service, common, page } = yield* boot();
  const kit = databaseKit(service, common, page.spaceId);
  const created = yield* kit.create("Work", {
    appendToPageId: page.id,
    properties: [
      { id: note, name: "Note", type: "text" },
      { id: points, name: "Points", type: "number" },
      { id: state, name: "State", type: "status" },
    ],
  });
  const tasks = created.dataSourceId;
  const projects = (yield* service.createDataSource({
    ...common,
    mutationId: "projects-source",
    databaseId: created.databaseId,
    name: "Projects",
  })).dataSourceId;
  const [p1, p2] = (yield* kit.addRows(projects, [{ title: "P1" }, { title: "P2" }])).rows.map(
    (row) => row.pageId,
  );
  yield* kit.schema(tasks, [
    {
      op: "addProperty",
      property: {
        id: project,
        name: "Project",
        type: "relation",
        config: { dataSourceId: projects, limit: "many", twoWay: { propertyId: pid("back01") } },
      },
    },
  ]);
  const template = (yield* kit.addRows(tasks, [
    { title: "Template", icon: "⭐", asTemplate: true },
  ])).rows[0]!.pageId;
  return { service, common, page, kit, created, tasks, projects, p1: p1!, p2: p2!, template };
});

it.layer(NodeServices.layer)("Spaces database templates", (it) => {
  it.effect("copies icon and cells, lets the draft win, mirrors relations and keeps defaults", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, created, tasks, p1, p2, template, projects } = yield* setup();
        const config = (yield* kit.get(created.databaseId)).dataSources[0]!.properties[state]!
          .config as { options: { id: string }[]; defaultOptionId: string };
        const other = config.options.find((o) => o.id !== config.defaultOptionId)!.id;
        yield* kit.setCells(tasks, template, {
          [note]: run("from template"),
          [points]: 5,
          [project]: [p1],
          [state]: other,
        });
        const made = yield* kit.addRows(tasks, [
          { templateId: template, title: "A" },
          { templateId: template, title: "B", cells: { [points]: 9, [project]: [p2] } },
        ]);
        const [a, b] = made.rows.map((row) => row.pageId);
        const first = (yield* kit.row(a!)).row;
        assert.equal(first.page.title, "A");
        assert.equal(first.page.icon, "⭐");
        assert.deepEqual(first.cells[note], run("from template"));
        assert.equal(first.cells[points], 5);
        assert.deepEqual(first.cells[project], [p1]);
        assert.equal(first.cells[state], other);
        const second = (yield* kit.row(b!)).row;
        assert.equal(second.cells[points], 9);
        assert.deepEqual(second.cells[project], [p2]);
        assert.deepEqual(second.cells[note], run("from template"));
        // The twin on the project row lists the template-created row.
        const back = (yield* kit.row(p1)).row.cells[pid("back01")] as string[];
        assert.sameMembers(back, [template, a!]);
        assert.isDefined(projects);
        // A template without a status value leaves the status default to apply.
        yield* kit.setCells(tasks, template, { [state]: null });
        const defaulted = (yield* kit.addRows(tasks, [{ templateId: template }])).rows[0]!.pageId;
        assert.equal((yield* kit.row(defaulted)).row.cells[state], config.defaultOptionId);
        // A template can itself be created from a template.
        const nested = (yield* kit.addRows(tasks, [{ templateId: template, asTemplate: true }]))
          .rows[0]!;
        assert.isTrue((yield* kit.row(nested.pageId)).template);
      }),
    ),
  );

  it.effect(
    "copies the body with new ids, nesting and search text, skipping child pages and databases",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, kit, tasks, template } = yield* setup();
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "template-body",
            pageId: template,
            baseRevision: 0,
            generation: 0,
            mutations: [
              {
                kind: "insert",
                block: { ...block("tbullet", 1), type: "bulleted_item" },
              },
              { kind: "insert", block: block("tchild", 1, C.SpaceBlockId.make("tbullet")) },
              { kind: "insert", block: block("tzebrafish", 2) },
            ],
          });
          yield* kit.create("Inner", { appendToPageId: template });
          const made = yield* kit.addRows(tasks, [{ templateId: template, title: "Copy" }]);
          const copy = made.rows[0]!.pageId;
          const window = yield* service.readBlocks({
            ...env,
            pageId: copy,
            revision: (yield* service.getPage({ ...env, pageId: copy })).page.revision,
          });
          assert.equal(window.blocks.length, 3);
          const ids = window.blocks.map((entry) => entry.id as string);
          assert.isFalse(ids.some((id) => ["tbullet", "tchild", "tzebrafish"].includes(id)));
          const bullet = window.blocks.find((entry) => entry.type === "bulleted_item")!;
          const child = window.blocks.find((entry) => entry.parentId !== null)!;
          assert.equal(child.parentId, bullet.id);
          assert.isFalse(window.blocks.some((entry) => entry.type === "database"));
          // The original keeps its blocks, and the copy's text is searchable.
          const original = yield* service.readBlocks({
            ...env,
            pageId: template,
            revision: (yield* service.getPage({ ...env, pageId: template })).page.revision,
          });
          assert.isTrue(original.blocks.some((entry) => entry.id === "tzebrafish"));
          yield* warmSearch(service);
          assert.include(
            (yield* service.search({ ...env, query: "tzebrafish" })).items.map(
              (item) => item.page.id,
            ),
            copy,
          );
          const stored = yield* raw(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{
                readonly n: number;
              }>`SELECT COUNT(*) AS n FROM spaces_blocks WHERE page_id = ${copy} AND deleted = 0`;
            }),
          );
          assert.equal(Number(stored[0]!.n), 3);
        }),
      ),
  );

  it.effect("rejects templates of another data source, plain rows and trashed templates", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, kit, tasks, projects, template, p1 } = yield* setup();
        const otherTemplate = (yield* kit.addRows(projects, [{ title: "PT", asTemplate: true }]))
          .rows[0]!.pageId;
        assert.equal(
          (yield* databaseError(kit.addRows(tasks, [{ templateId: otherTemplate }]))).reason,
          "not_a_row",
        );
        assert.equal(
          (yield* databaseError(kit.addRows(projects, [{ templateId: p1 }]))).reason,
          "not_a_row",
        );
        yield* service.trashPage(
          yield* recoveryIntent(service, common, template, "trash", "trash-template"),
        );
        const error = yield* Effect.flip(kit.addRows(tasks, [{ templateId: template }]));
        assert.equal(error._tag, "SpaceValidationError");
      }),
    ),
  );

  it.effect("copies the body when a skipped block has nested descendants", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, kit, tasks, template } = yield* setup();
        yield* service.applyBlockBatch({
          ...common,
          mutationId: "template-nested",
          pageId: template,
          baseRevision: 0,
          generation: 0,
          mutations: [
            { kind: "insert", block: block("tkeep", 5) },
            { kind: "insert", block: { ...block("tskip", 1), type: "bulleted_item" } },
            {
              kind: "insert",
              block: {
                ...block("tcontainer", 1, C.SpaceBlockId.make("tskip")),
                type: "bulleted_item",
              },
            },
            { kind: "insert", block: block("tdeep", 1, C.SpaceBlockId.make("tcontainer")) },
          ],
        });
        // A block type this build does not know is skipped by the copy, with its whole subtree.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const payload = JSON.stringify({
            ...block("tskip", 1),
            type: "future-widget",
            version: 7,
            content: {},
          });
          yield* sql`UPDATE spaces_blocks SET payload=${payload} WHERE block_id='tskip'`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        const made = yield* kit.addRows(tasks, [{ templateId: template, title: "Copy" }]);
        const copy = made.rows[0]!.pageId;
        const window = yield* service.readBlocks({
          ...env,
          pageId: copy,
          revision: (yield* service.getPage({ ...env, pageId: copy })).page.revision,
        });
        assert.equal(window.blocks.length, 1);
        assert.equal(window.blocks[0]!.parentId, null);
      }),
    ),
  );

  it.effect("fails a template with more blocks than one mutation may touch", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, kit, tasks, template } = yield* setup();
        for (const start of [0, 51]) {
          yield* service.applyBlockBatch({
            ...common,
            mutationId: `fill-${start}`,
            pageId: template,
            baseRevision: start === 0 ? 0 : 1,
            generation: 0,
            mutations: Array.from({ length: 51 }, (_, i) => ({
              kind: "insert" as const,
              block: block(`filler${start + i}`, start + i + 1),
            })),
          });
        }
        assert.equal(
          yield* limitError(kit.addRows(tasks, [{ templateId: template }])),
          "maxMutationNodes",
        );
      }),
    ),
  );

  it.effect("replays a template creation from its receipt with the same ids", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, tasks, template } = yield* setup();
        const request = {
          ...common,
          mutationId: C.SpaceMutationId.make("replay-template"),
          dataSourceId: tasks,
          rows: [{ templateId: template, title: "Once" }],
        };
        const first = yield* service.createRows(request);
        const again = yield* service.createRows(request);
        assert.deepEqual(again, first);
      }),
    ),
  );
});
