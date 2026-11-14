import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import { fixture } from "./spacesEditorBridge.support.ts";
import { rootReorderFixture } from "./spacesServiceFixtures.support.ts";
import {
  environmentId,
  holder,
  wireServer,
  call,
  type DatabasesWorld,
} from "./spacesDatabases.standin.support.ts";

export { type DatabasesWorld };

/** Boots a real SpacesService and publishes it to the stand-ins until `use` ends. */
export const withDatabasesWorld = <A, E>(use: (world: DatabasesWorld) => Effect.Effect<A, E>) =>
  fixture((service) =>
    Effect.gen(function* () {
      const capability = yield* service.getCapability(environmentId);
      if (!capability) return yield* Effect.die("The service reported no Spaces capability");
      const full = yield* wireServer(service, [
        AuthOrchestrationReadScope,
        AuthOrchestrationOperateScope,
      ]);
      const readOnly = yield* wireServer(service, [AuthOrchestrationReadScope]);
      const roots = yield* rootReorderFixture(service);
      const structure = roots.make();
      const log: DatabasesWorld["log"] = [];
      const world: DatabasesWorld = {
        log,
        service,
        capability,
        structure,
        page: roots.pages[0]!,
        spaceId: roots.spaceId,
        call: (tag, input) => {
          log.push({ tag, input });
          return call(full, tag, input);
        },
        readOnlyCall: (tag, input) => call(readOnly, tag, input),
      };
      holder.current = world;
      // The service runs on the test clock, so its admission windows sit near 1970; the client
      // judges them by Date, which has to agree.
      const now = vi.spyOn(Date, "now").mockReturnValue(0);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          holder.current = null;
          now.mockRestore();
        }),
      );
      return yield* use(world);
    }),
  );

const placements = new WeakMap<DatabasesWorld, number>();

/** Places a database block on a page the way a saved editor does. */
export const placeDatabaseBlock = Effect.fn("DatabasesIntegration.placeBlock")(function* (
  world: DatabasesWorld,
  databaseId: C.SpaceDatabaseId,
  viewIds: ReadonlyArray<C.SpaceViewId>,
) {
  const key = { environmentId, pageId: world.page };
  const current = yield* world.service.getPage(key);
  const blockId = C.SpaceBlockId.make(`database-${databaseId}`);
  const placed = (placements.get(world) ?? 0) + 1;
  placements.set(world, placed);
  yield* world.service.applyBlockBatch({
    ...key,
    mutationId: `place-${databaseId}`,
    receiptEpoch: current.mutationAdmission.epoch,
    baseRevision: current.page.revision,
    generation: 1,
    mutations: [
      {
        kind: "insert",
        block: {
          id: blockId,
          parentId: null,
          order: (placed * 0x10000).toString(16).padStart(32, "0"),
          type: "database",
          version: 1,
          content: { databaseId, viewIds: [...viewIds] },
        },
      },
    ],
  });
  return blockId;
});
