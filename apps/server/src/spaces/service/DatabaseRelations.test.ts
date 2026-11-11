import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { boot, fixture, recoveryIntent } from "./Spaces.testkit.ts";
import { databaseError, databaseKit, pid, raw } from "./Databases.testkit.ts";

const relationConfig = (target: C.SpaceDataSourceId, extra: object = {}) => ({
  dataSourceId: target,
  limit: "many",
  ...extra,
});

/** Projects (A) and Tasks (B) in one database, with a handful of rows each. */
const setup = Effect.fn("DatabaseRelationsTest.setup")(function* () {
  const { service, common, page } = yield* boot();
  const kit = databaseKit(service, common, page.spaceId);
  const created = yield* kit.create("Work", { appendToPageId: page.id });
  const projects = created.dataSourceId;
  const tasks = (yield* service.createDataSource({
    ...common,
    mutationId: "tasks-source",
    databaseId: created.databaseId,
    name: "Tasks",
  })).dataSourceId;
  const p = (yield* kit.addRows(projects, [{ title: "P1" }, { title: "P2" }])).rows.map(
    (r) => r.pageId,
  );
  const t = (yield* kit.addRows(tasks, [
    { title: "T1" },
    { title: "T2" },
    { title: "T3" },
  ])).rows.map((r) => r.pageId);
  return { service, common, page, kit, created, projects, tasks, p, t };
});

const cellsOf = (
  kit: ReturnType<typeof databaseKit>,
  pageId: C.SpacePageId,
  property: C.SpacePropertyId,
) => Effect.map(kit.row(pageId), (row) => row.row.cells[property]);

it.layer(NodeServices.layer)("Spaces database relations", (it) => {
  it.effect(
    "writes a one-way relation, validates targets and limits, and reads related pages",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { kit, projects, tasks, p, t } = yield* setup();
          const added = yield* kit.schema(tasks, [
            {
              op: "addProperty",
              property: {
                name: "Project",
                type: "relation",
                config: relationConfig(projects, { limit: "one" }),
              },
            },
          ]);
          const project = added.created[0]!.propertyId!;
          yield* kit.setCells(tasks, t[0]!, { [project]: [p[0]!] });
          const read = yield* kit.row(t[0]!);
          assert.deepEqual(read.row.cells[project], [p[0]!]);
          assert.deepEqual(read.relatedPages[p[0]!], { title: "P1", dataSourceId: projects });
          const tooMany = yield* databaseError(
            kit.setCells(tasks, t[0]!, { [project]: [p[0]!, p[1]!] }),
          );
          assert.equal(tooMany.reason, "relation_limit");
          // A row of the wrong data source, a stranger page and a trashed row are not valid targets.
          for (const target of [t[1]!, C.SpacePageId.make("nowhere")])
            assert.equal(
              (yield* databaseError(kit.setCells(tasks, t[0]!, { [project]: [target] }))).reason,
              "invalid_relation_target",
            );
          const { service, common } = kit;
          yield* service.trashPage(
            yield* recoveryIntent(service, common, p[1]!, "trash", "trash-p2"),
          );
          assert.equal(
            (yield* databaseError(kit.setCells(tasks, t[0]!, { [project]: [p[1]!] }))).reason,
            "invalid_relation_target",
          );
          yield* kit.setCells(tasks, t[0]!, { [project]: null });
          assert.isUndefined(yield* cellsOf(kit, t[0]!, project));
          const wrongSource = yield* databaseError(
            kit.schema(tasks, [
              {
                op: "addProperty",
                property: {
                  name: "Bad",
                  type: "relation",
                  config: { dataSourceId: "missing", limit: "many" },
                },
              },
            ]),
          );
          assert.equal(wrongSource.reason, "invalid_property_config");
          // The target data source of a relation cannot change.
          const retarget = yield* databaseError(
            kit.schema(tasks, [
              {
                op: "updateProperty",
                propertyId: project,
                config: relationConfig(tasks, { limit: "one" }),
              },
            ]),
          );
          assert.equal(retarget.reason, "invalid_property_config");
        }),
      ),
  );

  it.effect(
    "backfills a new twin and keeps both sides mirrored through set, clear and displacement",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { kit, projects, tasks, p, t, created } = yield* setup();
          const added = yield* kit.schema(tasks, [
            {
              op: "addProperty",
              property: { name: "Project", type: "relation", config: relationConfig(projects) },
            },
          ]);
          const project = added.created[0]!.propertyId!;
          yield* kit.setCells(tasks, t[0]!, { [project]: [p[0]!] });
          yield* kit.setCells(tasks, t[1]!, { [project]: [p[0]!, p[1]!] });
          const upgraded = yield* kit.schema(tasks, [
            {
              op: "updateProperty",
              propertyId: project,
              config: relationConfig(projects, { twoWay: { propertyId: "back01" } }),
            },
          ]);
          assert.deepEqual(upgraded.affectedDataSourceIds, [tasks, projects]);
          const twin = pid("back01");
          const source = (yield* kit.get(created.databaseId)).dataSources.find(
            (s) => s.id === projects,
          )!;
          assert.equal(source.properties[twin]!.name, "Tasks");
          assert.deepEqual(source.properties[twin]!.config, {
            dataSourceId: tasks,
            limit: "many",
            twoWay: { propertyId: project },
          });
          assert.deepEqual(yield* cellsOf(kit, p[0]!, twin), [t[0]!, t[1]!]);
          assert.deepEqual(yield* cellsOf(kit, p[1]!, twin), [t[1]!]);
          // A write on either side shows up on the other.
          yield* kit.setCells(projects, p[1]!, { [twin]: [t[2]!, t[1]!] });
          assert.deepEqual(yield* cellsOf(kit, t[2]!, project), [p[1]!]);
          assert.deepEqual(yield* cellsOf(kit, t[1]!, project), [p[0]!, p[1]!]);
          yield* kit.setCells(tasks, t[1]!, { [project]: null });
          assert.isUndefined(yield* cellsOf(kit, t[1]!, project));
          assert.deepEqual(yield* cellsOf(kit, p[0]!, twin), [t[0]!]);
          assert.deepEqual(yield* cellsOf(kit, p[1]!, twin), [t[2]!]);
          // Both data sources move their data revision.
          const sources = (yield* kit.get(created.databaseId)).dataSources;
          assert.isTrue(sources.every((s) => s.dataRevision > 0));
          const written = yield* kit.service.updateRows({
            ...kit.common,
            mutationId: "mirror-write",
            dataSourceId: tasks,
            rows: [{ pageId: t[1]!, cells: { [project]: [p[1]!] } }],
          });
          assert.sameMembers([...written.affectedDataSourceIds], [tasks, projects]);

          // A synced side limited to one displaces the previous owner on both sides.
          const lead = (yield* kit.schema(tasks, [
            {
              op: "addProperty",
              property: {
                name: "Lead",
                type: "relation",
                config: relationConfig(projects, { twoWay: { propertyId: "lead01" } }),
              },
            },
          ])).created[0]!.propertyId!;
          yield* kit.schema(projects, [
            {
              op: "updateProperty",
              propertyId: pid("lead01"),
              config: { dataSourceId: tasks, limit: "one", twoWay: { propertyId: lead } },
            },
          ]);
          yield* kit.setCells(tasks, t[0]!, { [lead]: [p[0]!] });
          yield* kit.setCells(tasks, t[2]!, { [lead]: [p[0]!] });
          assert.deepEqual(yield* cellsOf(kit, p[0]!, pid("lead01")), [t[2]!]);
          assert.isUndefined(yield* cellsOf(kit, t[0]!, lead));
          assert.deepEqual(yield* cellsOf(kit, t[2]!, lead), [p[0]!]);
        }),
      ),
  );

  it.effect(
    "hides trashed targets, restores them, and removes inbound cells on permanent delete",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { kit, service, common, projects, tasks, p, t } = yield* setup();
          const project = (yield* kit.schema(tasks, [
            {
              op: "addProperty",
              property: {
                name: "Project",
                type: "relation",
                config: relationConfig(projects, { twoWay: { propertyId: "back01" } }),
              },
            },
          ])).created[0]!.propertyId!;
          const twin = pid("back01");
          yield* kit.setCells(tasks, t[0]!, { [project]: [p[0]!, p[1]!] });
          yield* service.trashPage(
            yield* recoveryIntent(service, common, p[0]!, "trash", "trash-p1"),
          );
          assert.deepEqual(yield* cellsOf(kit, t[0]!, project), [p[1]!]);
          const stored = yield* raw(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql`SELECT COUNT(*) AS count FROM spaces_db_cells WHERE ref = ${p[0]!}`;
            }),
          );
          assert.deepEqual(stored, [{ count: 1 }]);
          yield* service.restorePage(
            yield* recoveryIntent(service, common, p[0]!, "restore", "restore-p1"),
          );
          assert.deepEqual(yield* cellsOf(kit, t[0]!, project), [p[0]!, p[1]!]);
          assert.deepEqual(yield* cellsOf(kit, p[0]!, twin), [t[0]!]);
          yield* service.trashPage(
            yield* recoveryIntent(service, common, p[0]!, "trash", "trash-p1-again"),
          );
          yield* service.permanentlyDeletePage(
            yield* recoveryIntent(service, common, p[0]!, "permanentlyDelete", "purge-p1"),
          );
          const left = yield* raw(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql`SELECT COUNT(*) AS count FROM spaces_db_cells WHERE ref = ${p[0]!} OR page_id = ${p[0]!}`;
            }),
          );
          assert.deepEqual(left, [{ count: 0 }]);
          assert.deepEqual(yield* cellsOf(kit, t[0]!, project), [p[1]!]);
          // Trashing a task hides it from the project's list too.
          yield* service.trashPage(
            yield* recoveryIntent(service, common, t[0]!, "trash", "trash-t1"),
          );
          assert.deepEqual(yield* cellsOf(kit, p[1]!, twin), undefined);
        }),
      ),
  );

  it.effect("soft-deletes the twin with a two-way property and restores both together", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, created, projects, tasks, p, t } = yield* setup();
        const project = (yield* kit.schema(tasks, [
          {
            op: "addProperty",
            property: {
              name: "Project",
              type: "relation",
              config: relationConfig(projects, { twoWay: { propertyId: "back01" } }),
            },
          },
        ])).created[0]!.propertyId!;
        const twin = pid("back01");
        yield* kit.setCells(tasks, t[0]!, { [project]: [p[0]!] });
        const removed = yield* kit.schema(tasks, [{ op: "removeProperty", propertyId: project }]);
        assert.deepEqual(removed.affectedDataSourceIds, [tasks, projects]);
        let sources = (yield* kit.get(created.databaseId)).dataSources;
        assert.isUndefined(sources.find((s) => s.id === projects)!.properties[twin]);
        // Writes no longer maintain a deleted twin, and it keeps its cells.
        const unlinked = yield* Effect.flip(kit.setCells(projects, p[0]!, { [twin]: [t[0]!] }));
        assert.equal(unlinked._tag, "SpaceNotFoundError");
        yield* kit.schema(tasks, [{ op: "restoreProperty", propertyId: project }]);
        sources = (yield* kit.get(created.databaseId)).dataSources;
        assert.isDefined(sources.find((s) => s.id === projects)!.properties[twin]);
        assert.deepEqual(yield* cellsOf(kit, p[0]!, twin), [t[0]!]);
        // Turning the twin off removes it the same way.
        yield* kit.schema(tasks, [
          { op: "updateProperty", propertyId: project, config: relationConfig(projects) },
        ]);
        sources = (yield* kit.get(created.databaseId)).dataSources;
        assert.isUndefined(sources.find((s) => s.id === projects)!.properties[twin]);
        assert.deepEqual(
          (sources.find((s) => s.id === tasks)!.properties[project]!.config as { twoWay?: unknown })
            .twoWay,
          undefined,
        );
      }),
    ),
  );

  it.effect("clears a relation and soft-deletes its twin when its type changes", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, created, projects, tasks, p, t } = yield* setup();
        const project = (yield* kit.schema(tasks, [
          {
            op: "addProperty",
            property: {
              name: "Project",
              type: "relation",
              config: relationConfig(projects, { twoWay: { propertyId: "back01" } }),
            },
          },
        ])).created[0]!.propertyId!;
        yield* kit.setCells(tasks, t[0]!, { [project]: [p[0]!] });
        const changed = yield* kit.schema(tasks, [
          { op: "changePropertyType", propertyId: project, type: "text" },
        ]);
        assert.equal(changed.clearedCells, 1);
        assert.deepEqual(changed.affectedDataSourceIds, [tasks, projects]);
        const sources = (yield* kit.get(created.databaseId)).dataSources;
        assert.isUndefined(sources.find((s) => s.id === projects)!.properties[pid("back01")]);
        assert.equal(sources.find((s) => s.id === tasks)!.properties[project]!.type, "text");
        assert.isUndefined(yield* cellsOf(kit, t[0]!, project));
      }),
    ),
  );

  it.effect("rejects a sub-item cycle through the parent chain and bad sub-item settings", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, created, projects } = yield* setup();
        const rows = (yield* kit.addRows(projects, [
          { title: "a" },
          { title: "b" },
          { title: "c" },
        ])).rows.map((r) => r.pageId);
        const parent = (yield* kit.schema(projects, [
          {
            op: "addProperty",
            property: {
              name: "Parent",
              type: "relation",
              config: relationConfig(projects, { limit: "one", twoWay: { propertyId: "kids01" } }),
            },
          },
        ])).created[0]!.propertyId!;
        const loose = (yield* kit.schema(projects, [
          {
            op: "addProperty",
            property: { name: "Loose", type: "relation", config: relationConfig(projects) },
          },
        ])).created[0]!.propertyId!;
        const refused = yield* databaseError(
          kit.service.updateDataSource({
            ...kit.common,
            mutationId: "bad-subitems",
            dataSourceId: projects,
            subItems: { parentPropertyId: loose },
          }),
        );
        assert.equal(refused.reason, "invalid_property_config");
        yield* kit.service.updateDataSource({
          ...kit.common,
          mutationId: "good-subitems",
          dataSourceId: projects,
          subItems: { parentPropertyId: parent },
        });
        const source = (yield* kit.get(created.databaseId)).dataSources.find(
          (s) => s.id === projects,
        )!;
        assert.deepEqual(source.subItems, {
          parentPropertyId: parent,
          childrenPropertyId: pid("kids01"),
        });
        yield* kit.setCells(projects, rows[1]!, { [parent]: [rows[0]!] });
        yield* kit.setCells(projects, rows[2]!, { [parent]: [rows[1]!] });
        for (const [row, target] of [
          [rows[0]!, rows[0]!],
          [rows[0]!, rows[2]!],
          [rows[0]!, rows[1]!],
        ] as const)
          assert.equal(
            (yield* databaseError(kit.setCells(projects, row, { [parent]: [target] }))).reason,
            "cycle",
          );
        assert.deepEqual(yield* cellsOf(kit, rows[0]!, pid("kids01")), [rows[1]!]);
        // Writing the children side is checked like the parent side, displacement included.
        const kids = pid("kids01");
        for (const [row, target] of [
          [rows[1]!, rows[0]!],
          [rows[2]!, rows[0]!],
          [rows[0]!, rows[0]!],
        ] as const)
          assert.equal(
            (yield* databaseError(kit.setCells(projects, row, { [kids]: [target] }))).reason,
            "cycle",
          );
        assert.deepEqual(yield* cellsOf(kit, rows[0]!, parent), undefined);
        assert.deepEqual(yield* cellsOf(kit, rows[1]!, parent), [rows[0]!]);
        // The sub-items relation cannot lose its twin or its limit while in use.
        const unlink = yield* databaseError(
          kit.schema(projects, [
            {
              op: "updateProperty",
              propertyId: parent,
              config: relationConfig(projects, { limit: "one" }),
            },
          ]),
        );
        assert.equal(unlink.reason, "invalid_property_config");
        yield* kit.schema(projects, [{ op: "removeProperty", propertyId: parent }]);
        const cleared = (yield* kit.get(created.databaseId)).dataSources.find(
          (s) => s.id === projects,
        )!;
        assert.isUndefined(cleared.subItems);
      }),
    ),
  );

  it.effect("keeps links to trashed rows through an edit, and a stale twin restores one-way", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, service, common, created, projects, tasks, p, t } = yield* setup();
        const project = (yield* kit.schema(tasks, [
          {
            op: "addProperty",
            property: {
              name: "Project",
              type: "relation",
              config: relationConfig(projects, { twoWay: { propertyId: "back01" } }),
            },
          },
        ])).created[0]!.propertyId!;
        const back = pid("back01");
        yield* kit.setCells(projects, p[0]!, { [back]: [t[0]!, t[1]!] });
        yield* service.trashPage(
          yield* recoveryIntent(service, common, t[1]!, "trash", "trash-t2"),
        );
        assert.deepEqual(yield* cellsOf(kit, p[0]!, back), [t[0]!]);
        yield* kit.setCells(projects, p[0]!, { [back]: [t[0]!, t[2]!] });
        yield* service.restorePage(
          yield* recoveryIntent(service, common, t[1]!, "restore", "restore-t2"),
        );
        assert.deepEqual(yield* cellsOf(kit, p[0]!, back), [t[0]!, t[2]!, t[1]!]);
        assert.deepEqual(yield* cellsOf(kit, t[1]!, project), [p[0]!]);
        // Removing one side of the pair and restoring the other leaves a one-way property.
        yield* kit.schema(tasks, [
          { op: "updateProperty", propertyId: project, config: relationConfig(projects) },
        ]);
        yield* kit.schema(projects, [{ op: "restoreProperty", propertyId: back }]);
        const sources = (yield* kit.get(created.databaseId)).dataSources;
        const restored = sources.find((s) => s.id === projects)!.properties[back]!;
        assert.isUndefined((restored.config as { twoWay?: unknown }).twoWay);
        yield* kit.setCells(projects, p[1]!, { [back]: [t[0]!] });
        assert.deepEqual(yield* cellsOf(kit, t[0]!, project), [p[0]!]);
      }),
    ),
  );
});
