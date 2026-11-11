import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { overlapFilter, rowTitle } from "@t2code/client-runtime/spaces";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { databasePorts } from "../src/spaces/databases/data/ports.ts";
import {
  browser,
  createLiveDatabase,
  openSurface,
  type Surface,
} from "./spacesDatabases.client.support.ts";
import { environmentId } from "./spacesDatabases.standin.support.ts";
import {
  deleteBlock,
  placeDatabaseBlock,
  withDatabasesWorld,
  type DatabasesWorld,
} from "./spacesDatabases.support.ts";

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
const day = (n: number) => `2026-03-${String(n).padStart(2, "0")}`;

async function open(world: DatabasesWorld) {
  const registry = browser();
  const created = await createLiveDatabase(world, registry, "Tasks");
  const surface = await openSurface(
    registry,
    created.databaseId,
    world.capability.limits.databases!,
  );
  return { registry, created, surface };
}

/** Writes rows in the batches the server allows and waits for them to be stored. */
async function addRows(
  surface: Surface,
  rows: ReadonlyArray<{ title: string; cells?: Record<string, C.SpaceCellValue> }>,
) {
  const limit = surface.model().limits.maxRowsPerMutation;
  for (let from = 0; from < rows.length; from += limit)
    await databasePorts.run.createRows(surface.registry, environmentId, {
      dataSourceId: surface.dataSource().id,
      rows: rows.slice(from, from + limit),
    });
}

const queries = (world: DatabasesWorld) =>
  world.log.filter((entry) => entry.tag === "spaces.databases.query");

it.effect("a calendar month fills its windows with the rows that overlap it, and no others", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const { surface } = await open(world);
          const due = (await surface.actions.addProperty({ name: "Due", type: "date" }))!;
          await surface.saved();
          const windowSize = Math.min(100, surface.model().limits.maxQueryRows);
          const inMarch = windowSize + 20;
          await addRows(surface, [
            ...Array.from({ length: inMarch }, (_, n) => ({
              title: `March ${n}`,
              cells: { [due]: { start: day((n % 28) + 1) } },
            })),
            ...Array.from({ length: 30 }, (_, n) => ({
              title: `April ${n}`,
              cells: { [due]: { start: `2026-04-${String((n % 28) + 1).padStart(2, "0")}` } },
            })),
          ]);
          const query = surface.openQuery({
            fillRows: 500,
            extraFilter: overlapFilter(due, "date", "2026-03-01", "2026-03-31"),
            extraPropertyIds: [due],
          });
          await query.ready();
          await query.until(() => query.rows().length === inMarch);
          assert.equal(query.total(), inMarch);
          assert.isTrue(query.rows().every((row) => rowTitle(row).startsWith("March")));
          // The month arrives in windows, never as one oversized answer.
          const limits = queries(world).map((entry) => (entry.input as { limit?: number }).limit);
          assert.isAtLeast(limits.length, 2);
          assert.isAtMost(Math.max(...limits.map((limit) => limit ?? 0)), windowSize);
          assert.equal(query.snapshot().windows?.nextCursor ?? null, null);
          query.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);

it.effect("sub-items list top-level rows, expand under a parent and honour the view filter", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const { surface } = await open(world);
          const points = (await surface.actions.addProperty({
            name: "Points",
            type: "number",
            config: { format: "number" },
          }))!;
          await surface.actions.setSubItems(true);
          await surface.saved();
          const parentProperty = surface.dataSource().subItems!.parentPropertyId;
          const parent = (await surface.actions.createRow({ cells: { title: "Parent" } }))!;
          for (const [title, value] of [
            ["Child low", 1],
            ["Child high", 9],
          ] as const)
            await surface.actions.createRow({
              cells: { title, [points]: value, [parentProperty]: [parent.page.id] },
            });
          await surface.saved();

          const top = surface.openQuery({ scope: { parentRowId: null } });
          await top.ready();
          assert.deepEqual(top.rows().map(rowTitle), ["Parent"]);

          // Expanding the parent opens one more session for its children.
          const children = surface.openQuery({ scope: { parentRowId: parent.page.id } });
          await children.ready();
          assert.deepEqual(children.rows().map(rowTitle).sort(), ["Child high", "Child low"]);
          children.dispose();

          surface.actions.editView({
            filter: { property: points, operator: "greater_than", value: 5 },
          });
          await surface.saved();
          const filtered = surface.openQuery({ scope: { parentRowId: parent.page.id } });
          await filtered.ready();
          assert.deepEqual(filtered.rows().map(rowTitle), ["Child high"]);
          filtered.dispose();
          top.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);

it.effect("creates a row from a template and from the default template", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const { surface } = await open(world);
          const points = (await surface.actions.addProperty({
            name: "Points",
            type: "number",
            config: { format: "number" },
          }))!;
          await surface.saved();
          const template = (await surface.actions.createTemplate())!;
          await surface.saved();
          surface.actions.editCell(template, points, 5);
          await surface.actions.flushCells();
          const query = surface.openQuery();
          await query.ready();
          assert.equal(query.rows().length, 0, "templates are not rows of the view");

          const explicit = (await surface.actions.createRow({
            cells: { title: "From template" },
            templateId: template,
          }))!;
          const stored = (id: C.SpacePageId) =>
            run(world.service.getDatabaseRows({ environmentId, pageId: id }));
          assert.equal((await stored(explicit.page.id)).row.cells[points], 5);

          const blank = (await surface.actions.createRow({
            cells: { title: "Blank" },
            templateId: null,
          }))!;
          assert.isUndefined((await stored(blank.page.id)).row.cells[points]);

          await surface.actions.setDefaultTemplate(template);
          await surface.saved();
          assert.equal(surface.dataSource().defaultTemplateId, template);
          const fromDefault = (await surface.actions.createRow({
            cells: { title: "From default" },
          }))!;
          assert.equal((await stored(fromDefault.page.id)).row.cells[points], 5);
          await query.until(() => query.rows().length === 3);
          query.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);

it.effect(
  "a linked view keeps its own filter beside the home view and reports a deleted home",
  () =>
    Effect.scoped(
      withDatabasesWorld((world) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            const { registry, created, surface } = await open(world);
            const points = (await surface.actions.addProperty({
              name: "Points",
              type: "number",
              config: { format: "number" },
            }))!;
            await surface.saved();
            await addRows(
              surface,
              [1, 2, 3, 4, 5, 6].map((n) => ({ title: `Task ${n}`, cells: { [points]: n } })),
            );
            await surface.actions.createView("table");
            await surface.saved();
            const linkedViewId = surface.model().views.at(-1)!.id;
            await run(
              placeDatabaseBlock(world, created.databaseId, [linkedViewId], "linked-block"),
            );
            const linked = await openSurface(
              registry,
              created.databaseId,
              world.capability.limits.databases!,
              [linkedViewId],
            );
            linked.actions.editView({
              filter: { property: points, operator: "greater_than", value: 4 },
            });
            await linked.saved();

            const home = surface.openQuery();
            const beside = linked.openQuery();
            await home.ready();
            await beside.ready();
            assert.equal(home.total(), 6);
            assert.equal(beside.total(), 2);
            assert.isUndefined(surface.view().filter);
            home.dispose();
            beside.dispose();

            await run(deleteBlock(world, C.SpaceBlockId.make(`database-${created.databaseId}`)));
            await linked.reload();
            assert.isFalse(linked.model().database.live);
          });
        }),
      ),
    ).pipe(Effect.provide(live)),
);
