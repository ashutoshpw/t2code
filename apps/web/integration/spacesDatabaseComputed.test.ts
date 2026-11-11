import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { rowTitle } from "@t2code/client-runtime/spaces";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { databasePorts } from "../src/spaces/databases/data/ports.ts";
import { environmentId } from "./spacesDatabases.standin.support.ts";
import { browser, createLiveDatabase, openSurface } from "./spacesDatabases.client.support.ts";
import { withDatabasesWorld, type DatabasesWorld } from "./spacesDatabases.support.ts";

vi.mock(
  "../src/state/spaces",
  async () => (await import("./spacesDatabases.standin.support.ts")).stateSpacesModule,
);
vi.mock(
  "../src/spaces/sessionRuntime",
  async () => (await import("./spacesDatabases.standin.support.ts")).sessionRuntimeModule,
);
vi.mock("../../../packages/client-runtime/src/state/session.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../packages/client-runtime/src/state/session.ts")>();
  const { sessionStates } = await import("./spacesDatabases.sessions.support.ts");
  return {
    ...actual,
    createEnvironmentSessionAtoms: (
      runtime: Parameters<typeof actual.createEnvironmentSessionAtoms>[0],
    ) => ({ ...actual.createEnvironmentSessionAtoms(runtime), sessionStateAtom: sessionStates }),
  };
});

const live = Layer.merge(NodeServices.layer, NodeCrypto.layer);
const run = Effect.runPromise;
const number = (value: number) => ({ type: "number", value });

/** Projects and Tasks in two databases, related both ways: P1 has T1 and T2, P2 has T3. */
async function work(world: DatabasesWorld) {
  const registry = browser();
  const limits = world.capability.limits.databases!;
  const projectsDb = await createLiveDatabase(world, registry, "Projects");
  const tasksDb = await createLiveDatabase(world, registry, "Tasks");
  const projects = await openSurface(registry, projectsDb.databaseId, limits);
  const tasks = await openSurface(registry, tasksDb.databaseId, limits);
  const estimate = (await tasks.actions.addProperty({
    name: "Estimate",
    type: "number",
    config: { format: "number" },
  }))!;
  const link = (await tasks.actions.addRelation({
    name: "Project",
    target: projects.dataSource().id,
    limit: "many",
    twin: { name: "Tasks" },
  }))!;
  await tasks.saved();
  await projects.saved();
  const twin = Object.values(projects.dataSource().properties).find(
    (p) => p.type === "relation",
  )!.id;
  // The twin starts hidden on the target's views; showing it is the user's step.
  projects.actions.editView({ properties: { set: { [twin]: { visible: true } } } });
  await projects.saved();
  const p = [];
  for (const title of ["P1", "P2"])
    p.push((await projects.actions.createRow({ cells: { title } }))!.page.id);
  const t = [];
  for (const [title, hours] of [
    ["T1", 3],
    ["T2", 4],
    ["T3", 5],
  ] as const)
    t.push((await tasks.actions.createRow({ cells: { title, [estimate]: hours } }))!.page.id);
  tasks.actions.editCell(t[0]!, link, [p[0]!]);
  tasks.actions.editCell(t[1]!, link, [p[0]!]);
  tasks.actions.editCell(t[2]!, link, [p[1]!]);
  await tasks.actions.flushCells();
  return { registry, projects, tasks, estimate, link, twin, p, t };
}

it.effect("sets a relation across two databases and mirrors it on the twin", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const { projects, tasks, link, twin, p, t } = await work(world);
          const picker = projects.openQuery({ search: "P" });
          await picker.ready();
          assert.deepEqual(picker.rows().map(rowTitle).sort(), ["P1", "P2"]);
          picker.dispose();

          const theirs = projects.openQuery();
          await theirs.ready();
          await theirs.until(() => {
            const first = theirs.rows().find((row) => rowTitle(row) === "P1");
            return Array.isArray(first?.cells[twin]) && first.cells[twin].length === 2;
          });
          const pages = theirs.snapshot().relatedPages;
          assert.deepEqual(
            [...(theirs.rows().find((row) => rowTitle(row) === "P1")!.cells[twin] as string[])]
              .map((id) => pages[id]?.title)
              .sort(),
            ["T1", "T2"],
          );
          // Unlinking from the twin's side updates the property on the tasks.
          projects.actions.editCell(p[0]!, twin, [t[0]!]);
          await projects.actions.flushCells();
          const mine = tasks.openQuery();
          await mine.ready();
          assert.deepEqual(
            mine.rows().find((row) => rowTitle(row) === "T2")?.cells[link] ?? [],
            [],
          );
          mine.dispose();
          theirs.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);

it.effect(
  "recomputes a formula after an edit and a rollup after an edit in the related database",
  () =>
    Effect.scoped(
      withDatabasesWorld((world) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            const { projects, tasks, estimate, twin, p, t } = await work(world);
            const double = (await tasks.actions.addProperty({
              name: "Double",
              type: "formula",
              config: { expression: 'prop("Estimate") * 2' },
            }))!;
            const total = (await projects.actions.addProperty({
              name: "Total",
              type: "rollup",
              config: { relationPropertyId: twin, targetPropertyId: estimate, function: "sum" },
            }))!;
            await tasks.saved();
            await projects.saved();
            await run(world.service.drainComputed);
            const taskRows = tasks.openQuery();
            const projectRows = projects.openQuery();
            await taskRows.ready();
            await projectRows.ready();
            const cell = (handle: typeof taskRows, id: string, property: string) =>
              handle.rows().find((row) => row.page.id === id)?.cells[property];
            await taskRows.until(
              () => JSON.stringify(cell(taskRows, t[0]!, double)) === JSON.stringify(number(6)),
            );
            await projectRows.until(
              () => JSON.stringify(cell(projectRows, p[0]!, total)) === JSON.stringify(number(7)),
            );

            tasks.actions.editCell(t[0]!, estimate, 10);
            await tasks.actions.flushCells();
            await run(world.service.drainComputed);
            // The formula follows the edit of its input; the rollup follows through the related data source.
            await taskRows.until(
              () => JSON.stringify(cell(taskRows, t[0]!, double)) === JSON.stringify(number(20)),
            );
            await projectRows.until(
              () => JSON.stringify(cell(projectRows, p[0]!, total)) === JSON.stringify(number(14)),
            );

            // Filter and sort by the formula as its result type.
            tasks.actions.editView({
              filter: { property: double, operator: "greater_than", value: 9 },
              sorts: [{ property: double, direction: "descending" }],
            });
            taskRows.retarget(tasks.view());
            await taskRows.until(() => taskRows.total() === 2);
            assert.deepEqual(taskRows.rows().map(rowTitle), ["T1", "T3"]);
            taskRows.dispose();
            projectRows.dispose();
          });
        }),
      ),
    ).pipe(Effect.provide(live)),
);

it.effect(
  "answers computedPending for a rollup of a changed formula until the drain finishes",
  () =>
    Effect.scoped(
      withDatabasesWorld(
        (world) =>
          Effect.gen(function* () {
            yield* Effect.promise(async () => {
              const { projects, tasks, estimate, link, twin, p } = await work(world);
              const double = (await tasks.actions.addProperty({
                name: "Double",
                type: "formula",
                config: { expression: 'prop("Estimate") * 2' },
              }))!;
              const total = (await projects.actions.addProperty({
                name: "Total",
                type: "rollup",
                config: { relationPropertyId: twin, targetPropertyId: double, function: "sum" },
              }))!;
              await tasks.saved();
              await projects.saved();
              await run(world.service.drainComputed);

              // More rows read the formula than one mutation recomputes, so the rest queue.
              const limit = tasks.model().limits.maxRowsPerMutation;
              const homes: C.SpacePageId[] = [];
              for (const title of ["X1", "X2", "X3"])
                homes.push((await projects.actions.createRow({ cells: { title } }))!.page.id);
              const extra = Array.from({ length: 250 }, (_, n) => ({
                title: `Bulk ${n}`,
                cells: { [estimate]: 1, [link]: [homes[n % 3]!] },
              }));
              for (let from = 0; from < extra.length; from += limit)
                await databasePorts.run.createRows(tasks.registry, environmentId, {
                  dataSourceId: tasks.dataSource().id,
                  rows: extra.slice(from, from + limit),
                });
              await run(world.service.drainComputed);

              // The definition changes on the rows the rollup reads, in the other data source.
              await tasks.actions.updateSchema([
                {
                  op: "updateProperty",
                  propertyId: double,
                  config: { expression: 'prop("Estimate") * 3' },
                },
              ]);
              const rows = projects.openQuery();
              const taskRows = tasks.openQuery();
              await taskRows.ready();
              await rows.ready();
              assert.isTrue(taskRows.snapshot().computedPending);
              assert.isTrue(rows.snapshot().computedPending);
              taskRows.dispose();

              await run(world.service.drainComputed);
              const first = () => rows.rows().find((row) => row.page.id === p[0]!)?.cells[total];
              await rows.until(
                () =>
                  !rows.snapshot().computedPending &&
                  JSON.stringify(first()) === JSON.stringify(number(21)),
              );
              rows.dispose();
            });
          }),
        // The background drain would finish the queue before the query could see it.
        { backgroundDrain: false },
      ),
    ).pipe(Effect.provide(live)),
);

it.effect("refuses a formula with an error and keeps the schema unchanged", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const { tasks } = await work(world);
          const refused = await tasks.actions.updateSchema([
            {
              op: "addProperty",
              property: {
                id: C.SpacePropertyId.make("bad001"),
                name: "Bad",
                type: "formula",
                config: { expression: 'prop("Missing") +' },
              },
            },
          ]);
          // The server's refusal reaches the writer's caller as null, with the detail in a toast.
          assert.equal(refused, null);
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);
