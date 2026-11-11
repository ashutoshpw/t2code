import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { rowTitle } from "@t2code/client-runtime/spaces";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { toastManager } from "../src/components/ui/toast";
import { databasePorts } from "../src/spaces/databases/data/ports.ts";
import { browser, createLiveDatabase, openSurface } from "./spacesDatabases.client.support.ts";
import { environmentId } from "./spacesDatabases.standin.support.ts";
import { placeDatabaseBlock, withDatabasesWorld } from "./spacesDatabases.support.ts";

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

it.effect("creates an inline database on a page and shows its block and first view", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const registry = browser();
          const created = await databasePorts.run.create(registry, environmentId, {
            spaceId: world.spaceId,
            title: "Tasks",
          });
          await run(placeDatabaseBlock(world, created.databaseId, [created.viewId]));
          const blocks = await run(
            world.service.readBlocks({
              environmentId,
              pageId: world.page,
              revision: (await run(world.service.getPage({ environmentId, pageId: world.page })))
                .page.revision,
            }),
          );
          const block = blocks.blocks.find((entry) => entry.type === "database");
          assert.deepEqual(block?.content, {
            databaseId: created.databaseId,
            viewIds: [created.viewId],
          });

          const surface = await openSurface(
            registry,
            created.databaseId,
            world.capability.limits.databases!,
            [created.viewId],
          );
          assert.equal(surface.model().database.title, "Tasks");
          assert.equal(surface.view().id, created.viewId);
          assert.equal(surface.view().type, "table");
          const query = surface.openQuery();
          await query.ready();
          assert.equal(query.rows().length, 0);
          assert.equal(query.total(), 0);
          query.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);

it.effect("adds properties of several types and shows them as view columns", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const toasts: unknown[] = [];
          vi.spyOn(toastManager, "add").mockImplementation((toast) => {
            toasts.push(toast);
            return "toast";
          });
          const registry = browser();
          const created = await createLiveDatabase(world, registry, "Tasks");
          const surface = await openSurface(
            registry,
            created.databaseId,
            world.capability.limits.databases!,
          );
          const ids = {
            note: await surface.actions.addProperty({ name: "Note", type: "url" }),
            points: await surface.actions.addProperty({
              name: "Points",
              type: "number",
              config: { format: "number" },
            }),
            done: await surface.actions.addProperty({ name: "Done", type: "checkbox" }),
            due: await surface.actions.addProperty({ name: "Due", type: "date" }),
            status: await surface.actions.addProperty({
              name: "Priority",
              type: "select",
              options: [{ name: "Low" }, { name: "High" }],
            }),
          };
          for (const id of Object.values(ids)) assert.notEqual(id, null, JSON.stringify(toasts));
          await surface.saved();
          const properties = Object.values(surface.dataSource().properties).map(
            (property) => property.type,
          );
          assert.deepEqual(properties.sort(), [
            "checkbox",
            "date",
            "number",
            "select",
            "title",
            "url",
          ]);
          // The view shows the new columns: addProperty appends them to the active view.
          const shown = surface.view().properties.filter((entry) => entry.visible).length;
          assert.isAtLeast(shown, 5);
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);

it.effect("applies a cell edit at once and reconciles with the server", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const registry = browser();
          const created = await createLiveDatabase(world, registry, "Tasks");
          const surface = await openSurface(
            registry,
            created.databaseId,
            world.capability.limits.databases!,
          );
          const points = (await surface.actions.addProperty({
            name: "Points",
            type: "number",
            config: { format: "number" },
          }))!;
          await surface.saved();
          const query = surface.openQuery();
          await query.ready();
          const row = (await surface.actions.createRow({ cells: { title: "First" } }))!;
          await query.until(() => query.rows().length === 1);
          assert.equal(rowTitle(query.rows()[0]!), "First");

          surface.actions.editCell(row.page.id, points, 41);
          // Before any request: the pending edit patches the row.
          assert.equal(query.rows()[0]!.cells[points], 41);
          assert.equal(surface.writer.getSnapshot().pending !== undefined, true);
          await surface.actions.flushCells();
          assert.deepEqual(surface.writer.getSnapshot().pending, {});
          assert.equal(query.rows()[0]!.cells[points], 41);
          const stored = await run(
            world.service.getDatabaseRows({ environmentId, pageId: row.page.id }),
          );
          assert.equal(stored.row.cells[points], 41);
          query.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);

void C;
