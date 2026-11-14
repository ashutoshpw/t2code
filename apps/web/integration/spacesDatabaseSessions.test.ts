import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { rowTitle } from "@t2code/client-runtime/spaces";
import { AuthOrchestrationOperateScope } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { toastManager } from "../src/components/ui/toast";
import { databasePorts } from "../src/spaces/databases/data/ports.ts";
import { browser, createLiveDatabase, openSurface } from "./spacesDatabases.client.support.ts";
import { environmentId } from "./spacesDatabases.standin.support.ts";
import { withDatabasesWorld } from "./spacesDatabases.support.ts";

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

const TITLE = C.SpacePropertyId.make(C.SPACE_TITLE_PROPERTY_ID);
const live = Layer.merge(NodeServices.layer, NodeCrypto.layer);
const run = Effect.runPromise;

it.effect("edits a row's title and a property, and the view reflects both", () =>
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
          const note = (await surface.actions.addProperty({ name: "Note", type: "url" }))!;
          await surface.saved();
          const query = surface.openQuery();
          await query.ready();
          const row = (await surface.actions.createRow({ cells: { title: "Draft" } }))!;
          await query.until(() => query.rows().length === 1);
          const seen: unknown[] = [];
          vi.spyOn(toastManager, "add").mockImplementation((toast) => {
            seen.push(toast);
            return "toast";
          });
          surface.actions.editCell(row.page.id, TITLE, "Final");
          surface.actions.editCell(row.page.id, note, "hello");
          await surface.actions.flushCells();
          assert.equal(rowTitle(query.rows()[0]!), "Final", JSON.stringify(seen));
          assert.equal(query.rows()[0]!.cells[note], "hello");
          const stored = await run(
            world.service.getDatabaseRows({ environmentId, pageId: row.page.id }),
          );
          assert.equal(stored.row.page.title, "Final");
          assert.equal(stored.row.cells[note], "hello");
          query.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);

it.effect("trashes a row through the structure owner and restores it", () =>
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
          const query = surface.openQuery();
          await query.ready();
          const rows = [];
          for (const title of ["One", "Two"])
            rows.push((await surface.actions.createRow({ cells: { title } }))!);
          await query.until(() => query.total() === 2);
          assert.equal(await surface.actions.trashRow(rows[0]!.page.id), true);
          await query.until(() => query.total() === 1);
          assert.deepEqual(query.rows().map(rowTitle), ["Two"]);

          const owner = world.structure;
          await owner.previewRecovery(rows[0]!.page.id, "restore");
          const preview = owner.getSnapshot().recoveryPreview!;
          await owner.confirmRecovery(preview, false);
          databasePorts.rowPageChanged(registry, environmentId, rows[0]!.page.id);
          await query.until(() => query.total() === 2);
          assert.deepEqual(query.rows().map(rowTitle).sort(), ["One", "Two"]);
          query.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);

it.effect("shows a second client's edit in its open view", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const first = browser();
          const created = await createLiveDatabase(world, first, "Tasks");
          const a = await openSurface(
            first,
            created.databaseId,
            world.capability.limits.databases!,
          );
          const note = (await a.actions.addProperty({ name: "Note", type: "url" }))!;
          await a.saved();
          const row = (await a.actions.createRow({ cells: { title: "Shared" } }))!;
          const b = await openSurface(
            browser(),
            created.databaseId,
            world.capability.limits.databases!,
          );
          const mine = a.openQuery();
          const theirs = b.openQuery();
          await mine.ready();
          await theirs.ready();
          assert.equal(theirs.rows()[0]!.cells[note], undefined);
          a.actions.editCell(row.page.id, note, "from A");
          await a.actions.flushCells();
          await theirs.until(() => theirs.rows()[0]?.cells[note] === "from A");
          mine.dispose();
          theirs.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);

it.effect("refuses writes from a client that only holds the read grant", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const owner = browser();
          const created = await createLiveDatabase(world, owner, "Tasks");
          const writable = await openSurface(
            owner,
            created.databaseId,
            world.capability.limits.databases!,
          );
          const row = (await writable.actions.createRow({ cells: { title: "Locked" } }))!;
          const toasts: unknown[] = [];
          vi.spyOn(toastManager, "add").mockImplementation((toast) => {
            toasts.push(toast);
            return "toast";
          });
          const reader = await openSurface(
            browser({ readOnly: true }),
            created.databaseId,
            world.capability.limits.databases!,
          );
          assert.deepEqual(
            Object.values(reader.model().permissions).filter((granted) => granted),
            [true],
          );
          const query = reader.openQuery();
          await query.ready();
          assert.equal(rowTitle(query.rows()[0]!), "Locked");
          reader.actions.editCell(row.page.id, TITLE, "Changed");
          await reader.actions.flushCells();
          // The writer keeps the refused edit for a retry; nothing reaches the server.
          assert.equal(reader.writer.getSnapshot().failed, 1);
          assert.deepEqual(toasts, []);
          const stored = await run(
            world.service.getDatabaseRows({ environmentId, pageId: row.page.id }),
          );
          assert.equal(stored.row.page.title, "Locked");

          // The server refuses on its own when the client check is bypassed.
          const refused = await run(
            Effect.flip(
              world.readOnlyCall("spaces.databases.rows.update", {
                environmentId,
                mutationId: "bypass",
                receiptEpoch: "x",
                dataSourceId: reader.dataSource().id,
                rows: [{ pageId: row.page.id, cells: { title: "Changed" } }],
              }),
            ),
          );
          assert.deepEqual(
            {
              tag: (refused as { _tag?: string })._tag,
              scope: (refused as { requiredScope?: string }).requiredScope,
            },
            { tag: "EnvironmentAuthorizationError", scope: AuthOrchestrationOperateScope },
          );
          query.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);
