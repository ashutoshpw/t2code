import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { env, fixture, recoveryIntent } from "./Spaces.testkit.ts";
import { exec, pid, raw } from "./Databases.testkit.ts";
import { ids, numberValue, setupWork, stringValue } from "./DatabaseComputed.testkit.ts";

const TOTAL = pid("tot001");
const NAMES = pid("names01");
const FIRST = pid("first01");

/** Tasks: Double = Estimate * 2. Projects: Total = sum(Estimate), Names = join of task names. */
const withComputed = Effect.fn("DatabaseComputedInvalidationTest.setup")(function* () {
  const work = yield* setupWork();
  yield* work.addComputed(work.projects, TOTAL, "Total", "rollup", {
    relationPropertyId: ids.tasksOf,
    targetPropertyId: ids.est,
    function: "sum",
  });
  yield* work.addComputed(work.projects, NAMES, "Names", "formula", {
    expression: 'prop("Tasks").map(current.prop("Name")).join(", ")',
  });
  yield* work.addComputed(work.tasks, FIRST, "Owner", "formula", {
    expression: 'prop("Project").first().prop("Name")',
  });
  return work;
});

const queued = (dbPath: string) =>
  raw(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly page_id: string }>`SELECT page_id FROM spaces_db_computed_dirty`;
    }),
  );

it.layer(NodeServices.layer)("Spaces computed invalidation", (it) => {
  it.effect("recomputes dependents on own, target and both sides of a relation edit", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, tasks, projects, p, t, cell } = yield* withComputed();
        assert.deepEqual(yield* cell(p[0]!, TOTAL), numberValue(7));
        assert.deepEqual(yield* cell(p[0]!, NAMES), stringValue("T1, T2"));
        assert.deepEqual(yield* cell(t[0]!, FIRST), stringValue("P1"));
        // Target-row edit: a task's estimate changes the project's rollup.
        yield* kit.setCells(tasks, t[0]!, { [ids.est]: 10 });
        assert.deepEqual(yield* cell(p[0]!, TOTAL), numberValue(14));
        // Relation edit from the task side moves the task between projects.
        yield* kit.setCells(tasks, t[1]!, { [ids.project]: [p[1]!] });
        assert.deepEqual(yield* cell(p[0]!, TOTAL), numberValue(10));
        assert.deepEqual(yield* cell(p[1]!, TOTAL), numberValue(9));
        assert.deepEqual(yield* cell(p[1]!, NAMES), stringValue("T3, T2"));
        assert.deepEqual(yield* cell(t[1]!, FIRST), stringValue("P2"));
        // And from the project side, through the synced property.
        yield* kit.setCells(projects, p[0]!, { [ids.tasksOf]: [t[0]!, t[2]!] });
        assert.deepEqual(yield* cell(p[0]!, TOTAL), numberValue(15));
        // The task side allows many projects, so T3 now sits in both and keeps P2 first.
        assert.deepEqual(yield* cell(p[1]!, TOTAL), numberValue(9));
        assert.deepEqual(yield* cell(t[2]!, FIRST), stringValue("P2"));
      }),
    ),
  );

  it.effect("follows a title edit through updatePage and through the title cell", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, kit, tasks, p, t, cell } = yield* withComputed();
        const revision = (yield* kit.row(t[0]!)).row.page.revision;
        yield* service.updatePage({
          ...common,
          mutationId: "rename-t1",
          pageId: t[0]!,
          baseRevision: revision,
          title: "Task one",
        });
        assert.deepEqual(yield* cell(p[0]!, NAMES), stringValue("Task one, T2"));
        yield* kit.setCells(tasks, t[1]!, { title: "Task two" });
        assert.deepEqual(yield* cell(p[0]!, NAMES), stringValue("Task one, Task two"));
      }),
    ),
  );

  it.effect("reports the data sources whose computed values changed with row and page edits", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, kit, tasks, projects, p, t } = yield* withComputed();
        const created = yield* service.createRows({
          ...common,
          mutationId: C.SpaceMutationId.make("create-affecting"),
          dataSourceId: tasks,
          rows: [{ title: "T4", cells: { [ids.project]: [p[0]!], [ids.est]: 5 } }],
        });
        assert.sameMembers([...(created.affectedDataSourceIds ?? [])], [tasks, projects]);
        const revision = (yield* kit.row(t[0]!)).row.page.revision;
        const renamed = yield* service.updatePage({
          ...common,
          mutationId: "rename-affecting",
          pageId: t[0]!,
          baseRevision: revision,
          title: "Task one",
        });
        assert.sameMembers(
          renamed.status === "saved" ? [...(renamed.affectedDataSourceIds ?? [])] : [],
          [tasks, projects],
        );
        const trashed = yield* service.trashPage(
          yield* recoveryIntent(service, common, t[0]!, "trash", "trash-affecting"),
        );
        assert.include(
          trashed.status === "saved" ? (trashed.affectedDataSourceIds ?? []) : [],
          projects,
        );
        const restored = yield* service.restorePage(
          yield* recoveryIntent(service, common, t[0]!, "restore", "restore-affecting"),
        );
        assert.include(
          restored.status === "saved" ? (restored.affectedDataSourceIds ?? []) : [],
          projects,
        );
        yield* service.trashPage(
          yield* recoveryIntent(service, common, t[0]!, "trash", "trash-affecting-2"),
        );
        const purged = yield* service.permanentlyDeletePage(
          yield* recoveryIntent(service, common, t[0]!, "permanentlyDelete", "purge-affecting"),
        );
        assert.include(
          purged.status === "saved" ? (purged.affectedDataSourceIds ?? []) : [],
          projects,
        );
      }),
    ),
  );

  it.effect("recomputes referrers when a target is trashed, restored or deleted for good", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, p, t, cell } = yield* withComputed();
        yield* service.trashPage(
          yield* recoveryIntent(service, common, t[0]!, "trash", "trash-t1"),
        );
        assert.deepEqual(yield* cell(p[0]!, TOTAL), numberValue(4));
        assert.deepEqual(yield* cell(p[0]!, NAMES), stringValue("T2"));
        yield* service.restorePage(
          yield* recoveryIntent(service, common, t[0]!, "restore", "restore-t1"),
        );
        assert.deepEqual(yield* cell(p[0]!, TOTAL), numberValue(7));
        assert.deepEqual(yield* cell(t[0]!, FIRST), stringValue("P1"));
        yield* service.trashPage(
          yield* recoveryIntent(service, common, t[0]!, "trash", "trash-t1b"),
        );
        yield* service.permanentlyDeletePage(
          yield* recoveryIntent(service, common, t[0]!, "permanentlyDelete", "purge-t1"),
        );
        assert.deepEqual(yield* cell(p[0]!, TOTAL), numberValue(4));
        // A trashed project stops showing as the owner of its tasks.
        yield* service.trashPage(
          yield* recoveryIntent(service, common, p[1]!, "trash", "trash-p2"),
        );
        assert.isUndefined(yield* cell(t[2]!, FIRST));
      }),
    ),
  );

  it.effect("never queues template rows and never stamps the row it computes", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { kit, tasks, p, t, cell } = yield* withComputed();
        yield* kit.addRows(tasks, [
          { title: "Template", asTemplate: true, cells: { [ids.est]: 99 } },
        ]);
        assert.deepEqual(yield* queued(dbPath), []);
        const template = yield* raw(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT COUNT(*) AS n FROM spaces_db_cells c JOIN spaces_pages p ON p.page_id = c.page_id
              WHERE p.row_template = 1 AND c.property_id = ${FIRST}`;
          }),
        );
        assert.deepEqual(template, [{ n: 0 }]);
        const before = (yield* kit.row(p[0]!)).row.page;
        yield* kit.setCells(tasks, t[0]!, { [ids.est]: 30 });
        assert.deepEqual(yield* cell(p[0]!, TOTAL), numberValue(34));
        const after = (yield* kit.row(p[0]!)).row.page;
        assert.equal(after.updatedAt, before.updatedAt);
        assert.equal(after.revision, before.revision);
      }),
    ),
  );

  it.effect("returns the stored receipt on replay and queues nothing new", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, tasks, p, t, cell } = yield* withComputed();
        const input = {
          ...common,
          mutationId: "replayed",
          dataSourceId: tasks,
          rows: [{ pageId: t[0]!, cells: { [ids.est]: 50 } }],
        };
        const first = yield* service.updateRows(input);
        assert.deepEqual(yield* cell(p[0]!, TOTAL), numberValue(54));
        yield* exec(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO spaces_db_computed_dirty (page_id, data_source_id) VALUES (${p[1]!}, 'x')`;
            yield* sql`DELETE FROM spaces_db_computed_dirty`;
            yield* sql`CREATE TABLE seen (page_id TEXT)`;
            yield* sql`CREATE TRIGGER seen_dirty AFTER INSERT ON spaces_db_computed_dirty BEGIN INSERT INTO seen VALUES (new.page_id); END`;
          }),
        );
        const again = yield* service.updateRows(input);
        assert.deepEqual(again, first);
        const seen = yield* raw(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT COUNT(*) AS n FROM seen`;
          }),
        );
        assert.deepEqual(seen, [{ n: 0 }]);
      }),
    ),
  );

  it.effect("computes 200 rows in the mutation, reports pending, and drains the rest", () =>
    fixture(
      () =>
        Effect.gen(function* () {
          const { service, kit, tasks, projects, cell } = yield* setupWork();
          const [hub] = (yield* kit.addRows(projects, [{ title: "Hub" }])).rows;
          // A one-way relation: a cell holds at most 100 links, but any number of rows may point at one.
          yield* kit.schema(tasks, [
            {
              op: "addProperty",
              property: {
                id: pid("hub0001"),
                name: "Hub",
                type: "relation",
                config: { dataSourceId: projects, limit: "many" },
              },
            },
            {
              op: "addProperty",
              property: {
                id: pid("owner01"),
                name: "OwnerName",
                type: "formula",
                config: { expression: 'prop("Hub").first().prop("Name")' },
              },
            },
          ]);
          const created: C.SpacePageId[] = [];
          for (let batch = 0; batch < 6; batch++)
            created.push(
              ...(yield* kit.addRows(
                tasks,
                Array.from({ length: 100 }, (_, i) => ({
                  title: `H${batch * 100 + i}`,
                  cells: { hub0001: [hub!.pageId] },
                })),
              )).rows.map((row) => row.pageId),
            );
          yield* service.drainComputed;
          assert.deepEqual(yield* cell(created[0]!, pid("owner01")), stringValue("Hub"));
          const ownerOf = (id: C.SpacePageId) =>
            Effect.map(cell(id, pid("owner01")), (value) => (value as { value?: string })?.value);
          // Renaming the hub queues all 600 referrers; the mutation computes 200 of them.
          yield* kit.setCells(projects, hub!.pageId, { title: "Renamed" });
          const query = () =>
            service.queryDatabase({
              ...env,
              dataSourceId: tasks,
              mode: "rows",
              timeZone: "UTC",
              limit: 1,
            });
          assert.isTrue((yield* query()).computedPending);
          assert.isTrue((yield* kit.row(created[0]!)).computedPending);
          let fresh = 0;
          for (const id of created) if ((yield* ownerOf(id)) === "Renamed") fresh++;
          assert.equal(fresh, 200);
          yield* service.drainComputed;
          assert.isUndefined((yield* query()).computedPending);
          for (const id of created) assert.equal(yield* ownerOf(id), "Renamed");
        }),
      true,
      { backgroundDrain: false },
    ),
  );

  it.effect("propagates formula over rollup over formula across data sources", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, tasks, projects, p, t, addComputed, cell } = yield* setupWork();
        yield* addComputed(tasks, "dbl001", "Double", "formula", {
          expression: 'prop("Estimate") * 2',
        });
        yield* addComputed(projects, "sum001", "SumDouble", "rollup", {
          relationPropertyId: ids.tasksOf,
          targetPropertyId: "dbl001",
          function: "sum",
        });
        yield* addComputed(projects, "plus01", "Plus", "formula", {
          expression: 'prop("SumDouble") + 1',
        });
        assert.deepEqual(yield* cell(p[0]!, pid("plus01")), numberValue(15));
        yield* kit.setCells(tasks, t[0]!, { [ids.est]: 10 });
        assert.deepEqual(yield* cell(p[0]!, pid("sum001")), numberValue(28));
        assert.deepEqual(yield* cell(p[0]!, pid("plus01")), numberValue(29));
      }),
    ),
  );
});
