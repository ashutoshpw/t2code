import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { databasePorts } from "../src/spaces/databases/data/ports.ts";
import { browser, createLiveDatabase, openSurface } from "./spacesDatabases.client.support.ts";
import { environmentId } from "./spacesDatabases.standin.support.ts";
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

/** A tab with a row and a Note property, and a second tab that has the same view open. */
async function twoTabs(world: DatabasesWorld) {
  const limits = world.capability.limits.databases!;
  const first = browser();
  const created = await createLiveDatabase(world, first, "Tasks");
  const mine = await openSurface(first, created.databaseId, limits);
  const note = (await mine.actions.addProperty({ name: "Note", type: "url" }))!;
  await mine.saved();
  const row = (await mine.actions.createRow({ cells: { title: "Shared" } }))!;
  const theirs = await openSurface(browser(), created.databaseId, limits);
  const mineView = mine.openQuery();
  const theirView = theirs.openQuery();
  await mineView.ready();
  await theirView.ready();
  assert.equal(theirView.rows()[0]!.cells[note], undefined);
  return { mine, mineView, theirView, note, row, dataSourceId: mine.dataSource().id };
}

it.effect("shows a second client's edit in an open view without any action", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const { mine, mineView, theirView, note, row } = await twoTabs(world);
          mine.actions.editCell(row.page.id, note, "from A");
          await mine.actions.flushCells();
          await theirView.until(() => theirView.rows()[0]?.cells[note] === "from A");
          mineView.dispose();
          theirView.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);

it.effect("shows an agent's edit made straight through the service", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const { mineView, theirView, note, row, dataSourceId } = await twoTabs(world);
          const admission = (await run(world.service.listSpaces({ environmentId })))
            .mutationAdmission;
          await run(
            world.service.updateRows({
              environmentId,
              receiptEpoch: admission.epoch,
              mutationId: C.SpaceMutationId.make("agent-edit"),
              dataSourceId,
              rows: [{ pageId: row.page.id, cells: { [note]: "from an agent" } }],
            }),
          );
          await Promise.all([
            theirView.until(() => theirView.rows()[0]?.cells[note] === "from an agent"),
            mineView.until(() => mineView.rows()[0]?.cells[note] === "from an agent"),
          ]);
          mineView.dispose();
          theirView.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);

it.effect("shows the result of a background recompute when the drain finishes", () =>
  Effect.scoped(
    withDatabasesWorld(
      (world) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            const limits = world.capability.limits.databases!;
            const registry = browser();
            const created = await createLiveDatabase(world, registry, "Heavy");
            const surface = await openSurface(registry, created.databaseId, limits);
            const dataSourceId = surface.dataSource().id;
            const rows = Array.from({ length: 90 }, (_, n) => ({ title: `Row ${n}` }));
            const size = surface.model().limits.maxRowsPerMutation;
            for (let from = 0; from < rows.length; from += size)
              await databasePorts.run.createRows(registry, environmentId, {
                dataSourceId,
                rows: rows.slice(from, from + size),
              });
            // More work than one mutation recomputes, so most rows queue for the drain.
            const heavy = (await surface.actions.addProperty({
              name: "Heavy",
              type: "formula",
              config: { expression: 'replaceAll(repeat("abc def ", 500), "[a-z]+", "x")' },
            }))!;
            await surface.saved();
            const view = surface.openQuery();
            await view.ready();
            assert.isTrue(view.snapshot().computedPending);
            const computed = () => view.rows().every((row) => row.cells[heavy] !== undefined);
            assert.isFalse(computed());

            await run(world.service.drainComputed);
            await view.until(() => !view.snapshot().computedPending && computed());
            view.dispose();
          });
        }),
      // The background drain would finish the queue before the view could see it pending.
      { backgroundDrain: false },
    ),
  ).pipe(Effect.provide(live)),
);
