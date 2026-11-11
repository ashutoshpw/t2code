import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { boot, env, fixture, moveIntent, recoveryIntent, rootPage } from "./Spaces.testkit.ts";
import {
  databaseError,
  databaseKit,
  limitError,
  raw,
  validationReason,
  warmSearch,
} from "./Databases.testkit.ts";

const blockFor = (
  id: string,
  databaseId: C.SpaceDatabaseId,
  viewIds: readonly C.SpaceViewId[] = [],
  n = 90,
): C.SpaceBlock => ({
  id: C.SpaceBlockId.make(id),
  parentId: null,
  order: n.toString(16).padStart(32, "0"),
  type: "database",
  version: 1,
  content: { databaseId, viewIds },
});
const insert = (block: C.SpaceBlock): C.SpaceBlockMutation => ({ kind: "insert", block });

it.layer(NodeServices.layer)("Spaces databases", (it) => {
  it.effect("creates a database in a page with a title property, table view and a row", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Tasks", {
          appendToPageId: page.id,
          properties: [{ name: "Done", type: "checkbox" }],
        });
        assert.equal(created.status, "saved");
        assert.lengthOf(created.propertyIds, 1);
        assert.isDefined(created.block);
        assert.equal(created.block?.revision, 1);
        const got = yield* kit.get(created.databaseId);
        assert.isTrue(got.database.live);
        assert.equal(got.database.home?.pageId, page.id);
        assert.equal(Object.keys(got.dataSources[0]!.properties).length, 2);
        assert.lengthOf(got.views, 1);
        assert.equal(got.views[0]!.ownerBlockId, created.block?.blockId);
        const rows = yield* kit.addRows(created.dataSourceId, [
          { title: "First", cells: { [created.propertyIds[0]!]: true } },
        ]);
        const row = yield* kit.row(rows.rows[0]!.pageId);
        assert.deepEqual(row.row.cells, { title: "First", [created.propertyIds[0]!]: true });
      }),
    ),
  );

  it.effect("manages database records and data sources, and lists only live databases", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Library", { appendToPageId: page.id });
        const unattached = yield* kit.create("Detached");
        const listed = yield* service.listDatabases(env);
        assert.deepEqual(
          listed.items.map((item) => item.database.id),
          [created.databaseId],
        );
        assert.equal((yield* kit.get(unattached.databaseId)).database.live, false);
        assert.equal(
          yield* validationReason(kit.addRows(unattached.dataSourceId, [{ title: "x" }])),
          "trashed",
        );
        const before = (yield* kit.get(created.databaseId)).database.revision;
        const renamed = yield* service.updateDatabase({
          ...common,
          mutationId: "rename-db",
          databaseId: created.databaseId,
          title: "Books",
          icon: "📚",
        });
        assert.equal(renamed.revision, before + 1);
        const unchanged = yield* service.updateDatabase({
          ...common,
          mutationId: "rename-db-noop",
          databaseId: created.databaseId,
          title: "Books",
        });
        assert.equal(unchanged.revision, before + 1);
        const cleared = yield* service.updateDatabase({
          ...common,
          mutationId: "clear-icon",
          databaseId: created.databaseId,
          icon: null,
        });
        assert.equal(cleared.revision, before + 2);
        assert.isUndefined((yield* kit.get(created.databaseId)).database.icon);

        const second = yield* service.createDataSource({
          ...common,
          mutationId: "second-source",
          databaseId: created.databaseId,
          name: "Authors",
          properties: [{ name: "Born", type: "date" }],
        });
        const got = yield* kit.get(created.databaseId);
        assert.deepEqual(
          got.dataSources.map((source) => source.name),
          ["Library", "Authors"],
        );
        assert.lengthOf(Object.keys(got.dataSources[1]!.properties), 2);
        yield* kit.addRows(second.dataSourceId, [{ title: "Ada" }]);
        const busy = yield* databaseError(
          service.deleteDataSource({
            ...common,
            mutationId: "delete-busy",
            dataSourceId: second.dataSourceId,
          }),
        );
        assert.equal(busy.reason, "data_source_not_empty");
        // Name limits.
        assert.equal(
          yield* limitError(
            service.createDataSource({
              ...common,
              mutationId: "long-name",
              databaseId: created.databaseId,
              name: "n".repeat(257),
            }),
          ),
          "databases.maxNameBytes",
        );
        for (let i = 0; i < 6; i++)
          yield* service.createDataSource({
            ...common,
            mutationId: `fill-${i}`,
            databaseId: created.databaseId,
            name: `Source ${i}`,
          });
        assert.equal(
          yield* limitError(
            service.createDataSource({
              ...common,
              mutationId: "ninth",
              databaseId: created.databaseId,
              name: "Ninth",
            }),
          ),
          "databases.maxDataSourcesPerDatabase",
        );
      }),
    ),
  );

  it.effect("lists databases in windows that stay valid across unrelated edits, per space", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const first = yield* kit.create("One", { appendToPageId: page.id });
        yield* TestClock.adjust("1 second");
        const second = yield* kit.create("Two", { appendToPageId: page.id });
        yield* kit.create("Dead");
        const windowed = yield* service.listDatabases({ ...env, limit: 1 });
        assert.deepEqual(
          windowed.items.map((item) => item.database.id),
          [first.databaseId],
        );
        assert.isNotNull(windowed.nextCursor);
        yield* service.updateDatabase({
          ...common,
          mutationId: "rename-between",
          databaseId: first.databaseId,
          title: "Renamed",
        });
        yield* kit.addRows(first.dataSourceId, [{ title: "row" }]);
        const next = yield* service.listDatabases({
          ...env,
          limit: 1,
          cursor: windowed.nextCursor!,
        });
        assert.deepEqual(
          next.items.map((item) => item.database.id),
          [second.databaseId],
        );
        // A trailing window may be empty when only a dead database follows; it must then end the list.
        if (next.nextCursor !== null) {
          const tail = yield* service.listDatabases({
            ...env,
            limit: 1,
            cursor: next.nextCursor,
          });
          assert.deepEqual(tail.items, []);
          assert.isNull(tail.nextCursor);
        }
        const otherSpace = (yield* service.createSpace({
          ...common,
          mutationId: "list-space",
          title: "Other",
        })).space;
        assert.deepEqual(
          (yield* service.listDatabases({ ...env, spaceId: otherSpace.id })).items,
          [],
        );
        const missing = yield* Effect.flip(kit.get(C.SpaceDatabaseId.make("missing")));
        assert.equal(missing._tag, "SpaceNotFoundError");
      }),
    ),
  );

  it.effect("deletes an empty data source with its views and ids, keeping the last one", () =>
    fixture((dbPath) =>
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
        const view = yield* service.createView({
          ...common,
          mutationId: "other-view",
          dataSourceId: other.dataSourceId,
          name: "Board",
          type: "table",
        });
        // A property of the first source relates to the second; its twin disappears with it.
        const link = (yield* kit.schema(created.dataSourceId, [
          {
            op: "addProperty",
            property: {
              name: "Other",
              type: "relation",
              config: {
                dataSourceId: other.dataSourceId,
                limit: "many",
                twoWay: { propertyId: "back01" },
              },
            },
          },
        ])).created[0]!.propertyId!;
        const deleted = yield* service.deleteDataSource({
          ...common,
          mutationId: "delete-other",
          dataSourceId: other.dataSourceId,
        });
        assert.isAbove(deleted.revision, 0);
        const got = yield* kit.get(created.databaseId);
        assert.lengthOf(got.dataSources, 1);
        assert.deepEqual(
          got.views.map((v) => v.dataSourceId),
          [created.dataSourceId],
        );
        assert.isUndefined(got.dataSources[0]!.properties[link]);
        assert.deepEqual(
          got.dataSources[0]!.deletedProperties.map((property) => property.id),
          [link],
        );
        const ids = yield* raw(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT id, deleted FROM spaces_ids WHERE id IN (${other.dataSourceId}, ${view.viewId}) ORDER BY id`;
          }),
        );
        assert.isTrue(ids.every((row) => row.deleted === 1));
        const last = yield* databaseError(
          service.deleteDataSource({
            ...common,
            mutationId: "delete-first",
            dataSourceId: created.dataSourceId,
          }),
        );
        assert.equal(last.reason, "last_data_source");
      }),
    ),
  );

  it.effect(
    "makes a database dead with its host page and alive again on restore, without touching rows",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const kit = databaseKit(service, common, page.spaceId);
          const created = yield* kit.create("Hosted", { appendToPageId: page.id });
          const rowId = (yield* kit.addRows(created.dataSourceId, [{ title: "Findable needle" }]))
            .rows[0]!.pageId;
          yield* service.addPin({ ...env, pageId: rowId });
          yield* service.recordRecent({ ...env, pageId: rowId });
          yield* warmSearch(service);
          const rowsBefore = yield* raw(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql`SELECT page_id, trash_batch_id FROM spaces_pages WHERE data_source_id IS NOT NULL`;
            }),
          );
          yield* service.trashPage(
            yield* recoveryIntent(service, common, page.id, "trash", "trash-host"),
          );
          const dead = yield* kit.get(created.databaseId);
          assert.isFalse(dead.database.live);
          assert.equal(yield* validationReason(kit.addRows(created.dataSourceId, [{}])), "trashed");
          assert.equal(yield* validationReason(kit.schema(created.dataSourceId, [])), "trashed");
          assert.equal(
            yield* validationReason(service.getPage({ ...env, pageId: rowId })),
            "trashed",
          );
          assert.equal(
            yield* validationReason(service.readBlocks({ ...env, pageId: rowId, revision: 0 })),
            "trashed",
          );
          assert.deepEqual((yield* service.listPins(env)).items, []);
          assert.deepEqual((yield* service.listRecents(env)).items, []);
          assert.deepEqual((yield* service.search({ ...env, query: "needle" })).items, []);
          assert.deepEqual(
            yield* service.resolveReference({ ...env, target: { kind: "page", pageId: rowId } }),
            { status: "trashed", pageId: rowId },
          );
          assert.deepEqual((yield* service.listDatabases(env)).items, []);
          const rowsDuring = yield* raw(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql`SELECT page_id, trash_batch_id FROM spaces_pages WHERE data_source_id IS NOT NULL`;
            }),
          );
          assert.deepEqual(rowsDuring, rowsBefore);
          yield* service.restorePage(
            yield* recoveryIntent(service, common, page.id, "restore", "restore-host"),
          );
          assert.isTrue((yield* kit.get(created.databaseId)).database.live);
          assert.equal((yield* service.getPage({ ...env, pageId: rowId })).page.id, rowId);
          assert.lengthOf((yield* service.listPins(env)).items, 1);
          assert.lengthOf((yield* service.search({ ...env, query: "needle" })).items, 1);
          yield* kit.addRows(created.dataSourceId, [{ title: "alive again" }]);
        }),
      ),
  );

  it.effect(
    "adopts a database when its home block is gone, and treats further blocks as linked views",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const kit = databaseKit(service, common, page.spaceId);
          const created = yield* kit.create("Adopted", { appendToPageId: page.id });
          const home = created.block!.blockId;
          const other = yield* rootPage(service, common, page.spaceId, "second-page");
          const linked = yield* service.applyBlockBatch({
            ...common,
            mutationId: "linked-view",
            pageId: other.id,
            baseRevision: 0,
            generation: 0,
            mutations: [insert(blockFor("linked-block", created.databaseId, [created.viewId]))],
          });
          assert.equal(linked.status, "saved");
          assert.equal((yield* kit.get(created.databaseId)).database.home?.blockId, home);
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "delete-home",
            pageId: page.id,
            baseRevision: 1,
            generation: 0,
            mutations: [{ kind: "delete", blockId: home }],
          });
          const dead = (yield* kit.get(created.databaseId)).database;
          assert.isFalse(dead.live);
          assert.isNull(dead.home);
          assert.deepEqual((yield* service.listDatabases(env)).items, []);
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "reinsert",
            pageId: page.id,
            baseRevision: 2,
            generation: 0,
            mutations: [insert(blockFor("new-home", created.databaseId, [created.viewId]))],
          });
          const revived = (yield* kit.get(created.databaseId)).database;
          assert.isTrue(revived.live);
          assert.equal(revived.home?.blockId, "new-home");
          // The earlier block on the other page stays a linked view and does not take over.
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "edit-linked",
            pageId: other.id,
            baseRevision: 1,
            generation: 0,
            mutations: [
              { kind: "replace", block: blockFor("linked-block", created.databaseId, [], 90) },
            ],
          });
          assert.equal((yield* kit.get(created.databaseId)).database.home?.blockId, "new-home");
        }),
      ),
  );

  it.effect("names a database in a context snapshot without expanding its rows", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Roadmap", { appendToPageId: page.id });
        yield* kit.addRows(created.dataSourceId, [{ title: "secret row title" }]);
        const captured = yield* service.captureContextSnapshot({
          ...env,
          contextId: "database-context",
          target: { kind: "page", pageId: page.id },
        });
        if (captured.status !== "captured") return yield* Effect.die("Expected capture");
        assert.include(captured.record.snapshot.text, `[database ${created.databaseId} "Roadmap"]`);
        assert.notInclude(captured.record.snapshot.text, "secret row title");
      }),
    ),
  );

  it.effect("validates database blocks written through the block path", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page, request } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Blocks", { appendToPageId: page.id });
        const lost = yield* Effect.flip(
          service.applyBlockBatch(
            request("ghost", 1, [insert(blockFor("ghost-block", C.SpaceDatabaseId.make("ghost")))]),
          ),
        );
        assert.equal(lost._tag, "SpaceNotFoundError");
        const otherSpace = (yield* service.createSpace({
          ...common,
          mutationId: "other-space",
          title: "Other",
        })).space;
        const foreign = yield* rootPage(service, common, otherSpace.id, "foreign-page");
        assert.equal(
          yield* validationReason(
            service.applyBlockBatch({
              ...common,
              mutationId: "foreign-block",
              pageId: foreign.id,
              baseRevision: 0,
              generation: 0,
              mutations: [insert(blockFor("foreign", created.databaseId))],
            }),
          ),
          "invalid_parent",
        );
        assert.equal(
          yield* validationReason(
            service.applyBlockBatch(
              request("swap", 1, [
                {
                  kind: "replace",
                  block: {
                    id: created.block!.blockId,
                    parentId: null,
                    order: "00000000000000000000000000000001",
                    type: "paragraph",
                    version: 1,
                    content: { runs: [] },
                  },
                },
              ]),
            ),
          ),
          "unsupported_block",
        );
        assert.equal(
          yield* limitError(
            service.applyBlockBatch(
              request("many-views", 1, [
                insert(
                  blockFor(
                    "wide",
                    created.databaseId,
                    Array.from({ length: 51 }, (_, i) => C.SpaceViewId.make(`v${i}`)),
                  ),
                ),
              ]),
            ),
          ),
          "databases.maxViewsPerDatabase",
        );
      }),
    ),
  );

  it.effect(
    "rejects moving a host page across spaces or into its own rows, and keeps it live within a space",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const kit = databaseKit(service, common, page.spaceId);
          const created = yield* kit.create("Moving", { appendToPageId: page.id });
          const rowId = (yield* kit.addRows(created.dataSourceId, [{ title: "row" }])).rows[0]!
            .pageId;
          const otherSpace = (yield* service.createSpace({
            ...common,
            mutationId: "far-space",
            title: "Far",
          })).space;
          const abroad = yield* moveIntent(service, common, page.id, "move-abroad", {
            kind: "root",
            spaceId: otherSpace.id,
            beforePageId: null,
          });
          assert.equal(yield* validationReason(service.movePage(abroad)), "invalid_parent");
          const inside = yield* moveIntent(service, common, page.id, "move-inside", {
            kind: "child",
            placement: { pageId: rowId, parentId: null, beforeBlockId: null },
          });
          assert.equal(yield* validationReason(service.movePage(inside)), "cycle");
          const parent = yield* rootPage(service, common, page.spaceId, "new-parent");
          const nested = yield* moveIntent(service, common, page.id, "move-nested", {
            kind: "child",
            placement: { pageId: parent.id, parentId: null, beforeBlockId: null },
          });
          assert.equal((yield* service.movePage(nested)).status, "saved");
          const got = yield* kit.get(created.databaseId);
          assert.isTrue(got.database.live);
          assert.equal(got.database.home?.pageId, page.id);
          // Moving the home block alone follows the same rules.
          const blockAbroad = yield* service.inspectStructure({
            ...env,
            target: { kind: "blocks", pageId: page.id, blockIds: [created.block!.blockId] },
            destination: {
              kind: "child",
              placement: { pageId: parent.id, parentId: null, beforeBlockId: null },
            },
          });
          assert.isAbove(blockAbroad.guards.pages.length, 0);
        }),
      ),
  );

  it.effect(
    "refuses adopting a database from one of its own rows and lets a nested database die with its host",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const kit = databaseKit(service, common, page.spaceId);
          const outer = yield* kit.create("Outer", { appendToPageId: page.id });
          const rowId = (yield* kit.addRows(outer.dataSourceId, [{ title: "host row" }])).rows[0]!
            .pageId;
          const nested = yield* kit.create("Nested", { appendToPageId: rowId });
          assert.isTrue((yield* kit.get(nested.databaseId)).database.live);
          yield* service.trashPage(
            yield* recoveryIntent(service, common, page.id, "trash", "trash-outer"),
          );
          assert.isFalse((yield* kit.get(nested.databaseId)).database.live);
          yield* service.restorePage(
            yield* recoveryIntent(service, common, page.id, "restore", "restore-outer"),
          );
          assert.isTrue((yield* kit.get(nested.databaseId)).database.live);
          // With its home block deleted its rows are unreachable, so nothing in one can adopt it.
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "drop-outer-home",
            pageId: page.id,
            baseRevision: 3,
            generation: 0,
            mutations: [{ kind: "delete", blockId: outer.block!.blockId }],
          });
          assert.equal(
            yield* validationReason(
              service.applyBlockBatch({
                ...common,
                mutationId: "adopt-into-own-row",
                pageId: rowId,
                baseRevision: 1,
                generation: 0,
                mutations: [insert(blockFor("self-block", outer.databaseId))],
              }),
            ),
            "trashed",
          );
        }),
      ),
  );
});
