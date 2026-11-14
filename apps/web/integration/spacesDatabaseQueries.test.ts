import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { knownProperty, rowTitle } from "@t2code/client-runtime/spaces";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { planCardDrop } from "../src/spaces/databases/board/boardDrag.ts";
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
const ROWS = 300;
const LOW = C.SpaceOptionId.make("low001");
const HIGH = C.SpaceOptionId.make("high01");

/** A database with 300 rows: Task 1..300, Points = n, Priority alternating Low and High. */
async function seeded(world: DatabasesWorld) {
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
  const priority = (await surface.actions.addProperty({
    name: "Priority",
    type: "select",
    options: [
      { id: LOW, name: "Low", color: "blue" },
      { id: HIGH, name: "High", color: "red" },
    ],
  }))!;
  await surface.saved();
  const limit = surface.model().limits.maxRowsPerMutation;
  for (let from = 1; from <= ROWS; from += limit) {
    const rows = [];
    for (let n = from; n < from + limit && n <= ROWS; n++)
      rows.push({
        title: `Task ${n}`,
        cells: { [points]: n, [priority]: n % 2 === 0 ? HIGH : LOW },
      });
    await surface.actions.flushCells();
    const result = await (
      await import("../src/spaces/databases/data/ports.ts")
    ).databasePorts.run.createRows(registry, surface.model().environmentId, {
      dataSourceId: surface.dataSource().id,
      rows,
    });
    assert.equal(result.rows.length, rows.length);
  }
  await surface.saved();
  return { registry, surface, points, priority };
}

it.effect("pages a few hundred rows in windows and requeries on filter and sort edits", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const { surface, points } = await seeded(world);
          const query = surface.openQuery();
          await query.ready();
          const windowSize = surface.model().limits.maxQueryRows;
          assert.equal(query.rows().length, windowSize);
          assert.equal(query.total(), ROWS);
          while (query.snapshot().windows?.nextCursor != null) {
            const loaded = query.rows().length;
            query.session.loadMore();
            await query.until(() => query.rows().length > loaded);
          }
          assert.equal(query.rows().length, ROWS);
          const asked = world.log
            .filter((entry) => entry.tag === "spaces.databases.query")
            .map((entry) => (entry.input as { limit?: number }).limit ?? 0);
          assert.isAtMost(Math.max(...asked), windowSize);

          surface.actions.editView({ sorts: [{ property: points, direction: "descending" }] });
          query.retarget(surface.view());
          await query.until(
            () => query.rows()[0] !== undefined && rowTitle(query.rows()[0]!) === "Task 300",
          );
          assert.equal(query.rows().length, windowSize);

          surface.actions.editView({
            filter: { property: points, operator: "greater_than", value: 290 },
          });
          query.retarget(surface.view());
          await query.until(() => query.total() === 10);
          assert.deepEqual(query.rows().map(rowTitle).slice(0, 2), ["Task 300", "Task 299"]);
          await surface.saved();
          assert.equal(surface.view().sorts.length, 1);
          assert.isDefined(surface.view().filter);
          query.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);

it.effect("groups by a select and a board drop writes the group cell", () =>
  Effect.scoped(
    withDatabasesWorld((world) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const { surface, priority } = await seeded(world);
          surface.actions.editView({ group: { property: priority } });
          const query = surface.openQuery({ mode: "groups", rowsPerGroup: 25 });
          await query.ready();
          const count = (optionId: string) =>
            query
              .groups()
              .find((bucket) => bucket.key.kind === "option" && bucket.key.optionId === optionId)
              ?.count;
          assert.equal(count(LOW), ROWS / 2);
          assert.equal(count(HIGH), ROWS / 2);
          const lowBucket = query
            .groups()
            .find((bucket) => bucket.key.kind === "option" && bucket.key.optionId === LOW)!;
          assert.equal(lowBucket.rows.length, 25);

          const card = lowBucket.rows[0]!;
          const known = knownProperty(surface.dataSource().properties[priority]!)!;
          const plan = planCardDrop({
            cardId: card.page.id,
            value: card.cells[priority],
            from: lowBucket.key,
            to: { kind: "option", optionId: HIGH },
            beforeRowId: null,
            view: surface.view(),
            known,
          });
          assert.deepEqual(plan?.cell, HIGH);
          const release = query.session.hold();
          surface.actions.editCell(card.page.id, priority, plan!.cell!);
          await surface.actions.flushCells();
          release();
          await query.until(() => count(HIGH) === ROWS / 2 + 1);
          assert.equal(count(LOW), ROWS / 2 - 1);
          const stored = await run(
            world.service.getDatabaseRows({
              environmentId: surface.model().environmentId,
              pageId: card.page.id,
            }),
          );
          assert.equal(stored.row.cells[priority], HIGH);

          // A bucket continues from its cursor, 25 rows at a time.
          query.session.loadBucket(lowBucket.key);
          await query.until(
            () =>
              query.groups().find((b) => b.key.kind === "option" && b.key.optionId === LOW)!.rows
                .length > 25,
          );
          query.dispose();
        });
      }),
    ),
  ).pipe(Effect.provide(live)),
);
