import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Statement from "effect/sql/Statement";

import { boot, fixture, moveIntent, rootPage } from "./Spaces.testkit.ts";
import {
  databaseError,
  databaseKit,
  limitError,
  pid,
  validationReason,
} from "./Databases.testkit.ts";

const LABEL = pid("label01");

const blockFor = (id: string, databaseId: C.SpaceDatabaseId, n = 90): C.SpaceBlock => ({
  id: C.SpaceBlockId.make(id),
  parentId: null,
  order: n.toString(16).padStart(32, "0"),
  type: "database",
  version: 1,
  content: { databaseId, viewIds: [] },
});

it.layer(NodeServices.layer)("Spaces database integrity", (it) => {
  it.effect("refuses to point a home block at a different database", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page, request } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const first = yield* kit.create("First", { appendToPageId: page.id });
        const second = yield* kit.create("Second", { appendToPageId: page.id });
        const home = first.block!.blockId;
        const swap = (databaseId: C.SpaceDatabaseId, viewIds: readonly C.SpaceViewId[] = []) =>
          service.applyBlockBatch(
            request(`swap-${databaseId}-${viewIds.length}`, 2, [
              {
                kind: "replace",
                block: {
                  id: home,
                  parentId: null,
                  order: "00000000000000000000000000000090",
                  type: "database",
                  version: 1,
                  content: { databaseId, viewIds },
                },
              },
            ]),
          );
        assert.equal(yield* validationReason(swap(second.databaseId)), "invalid_parent");
        // Naming its own database again stays fine, and the first database is still homed there.
        assert.equal((yield* swap(first.databaseId, [first.viewId])).status, "saved");
        assert.equal((yield* kit.get(first.databaseId)).database.home?.blockId, home);
      }),
    ),
  );

  it.effect("keeps the last view of a database when its data source is deleted", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Pair", { appendToPageId: page.id });
        const other = yield* service.createDataSource({
          ...common,
          mutationId: "other-source",
          databaseId: created.databaseId,
          name: "Other",
        });
        yield* service.createView({
          ...common,
          mutationId: "other-view",
          dataSourceId: other.dataSourceId,
          name: "Other table",
          type: "table",
        });
        yield* service.deleteView({ ...common, mutationId: "drop-first", viewId: created.viewId });
        const refused = yield* databaseError(
          service.deleteDataSource({
            ...common,
            mutationId: "delete-other",
            dataSourceId: other.dataSourceId,
          }),
        );
        assert.equal(refused.reason, "last_view");
        const got = yield* kit.get(created.databaseId);
        assert.lengthOf(got.dataSources, 2);
        assert.lengthOf(got.views, 1);
      }),
    ),
  );

  it.effect(
    "refuses to move a linked database block into a space that does not hold its database",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const kit = databaseKit(service, common, page.spaceId);
          const created = yield* kit.create("Linked", { appendToPageId: page.id });
          const host = yield* rootPage(service, common, page.spaceId, "link-host");
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "link",
            pageId: host.id,
            baseRevision: 0,
            generation: 0,
            mutations: [{ kind: "insert", block: blockFor("linked-block", created.databaseId) }],
          });
          const abroad = (yield* service.createSpace({
            ...common,
            mutationId: "abroad",
            title: "Abroad",
          })).space;
          const refused = yield* moveIntent(service, common, host.id, "move-abroad", {
            kind: "root",
            spaceId: abroad.id,
            beforePageId: null,
          });
          assert.equal(yield* validationReason(service.movePage(refused)), "invalid_parent");

          // Within a space no linked block is read.
          const statements: string[] = [];
          const observe: Statement.Transformer = (statement) => {
            statements.push(statement.compile()[0]);
            return Effect.succeed(statement);
          };
          const nested = yield* rootPage(service, common, page.spaceId, "nest-target");
          const within = yield* moveIntent(service, common, host.id, "move-within", {
            kind: "child",
            placement: { pageId: nested.id, parentId: null, beforeBlockId: null },
          });
          assert.equal(
            (yield* service
              .movePage(within)
              .pipe(Effect.provideService(Statement.CurrentTransformer, observe))).status,
            "saved",
          );
          assert.isAbove(statements.length, 0);
          assert.lengthOf(
            statements.filter((text) => text.includes("instr(payload")),
            0,
          );
        }),
      ),
  );

  it.effect("bounds the views of one database so reading them all always fits", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Wide", {
          appendToPageId: page.id,
          properties: [{ id: LABEL, name: "Label", type: "text" }],
        });
        const wide = (name: string) => ({
          ...common,
          mutationId: C.SpaceMutationId.make(`view-${name}`),
          dataSourceId: created.dataSourceId,
          name,
          type: "table" as const,
          filter: {
            and: Array.from({ length: 12 }, () => ({
              property: LABEL,
              operator: "contains" as const,
              value: "v".repeat(1_000),
            })),
          },
        });
        yield* service.createView(wide("first"));
        let made = 1;
        for (; made < 40; made++) {
          const failure = yield* Effect.flip(service.createView(wide(`wide-${made}`))).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (failure !== undefined) break;
        }
        assert.isAbove(made, 5);
        assert.isBelow(made, 40);
        assert.equal(
          yield* limitError(service.createView(wide("one-more"))),
          "databases.maxViewBytes",
        );
        const got = yield* kit.get(created.databaseId);
        assert.lengthOf(got.views, made + 1);
        assert.isAtMost(Buffer.byteLength(JSON.stringify(got), "utf8"), 1_048_576);
      }),
    ),
  );
});
