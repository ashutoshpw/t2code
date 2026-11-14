import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { boot, env, fixture } from "./Spaces.testkit.ts";
import { databaseError, databaseKit, limitError, oid, pid, raw } from "./Databases.testkit.ts";

const setup = Effect.fn("DatabaseViewsTest.setup")(function* () {
  const { service, common, page } = yield* boot();
  const kit = databaseKit(service, common, page.spaceId);
  const created = yield* kit.create("Views", {
    appendToPageId: page.id,
    properties: [
      { name: "Points", type: "number" },
      { name: "Tag", type: "select", options: [{ id: oid("aaaa"), name: "A" }] },
      { name: "When", type: "date" },
      { name: "Calc", type: "formula", config: { expression: "now()" } },
      { name: "Attach", type: "files" },
      { name: "Label", type: "text" },
    ],
  });
  const [points, tag, when, calc, attach, label] = created.propertyIds as [
    C.SpacePropertyId,
    C.SpacePropertyId,
    C.SpacePropertyId,
    C.SpacePropertyId,
    C.SpacePropertyId,
    C.SpacePropertyId,
  ];
  const create = (
    input: Partial<C.SpaceViewCreateInput> & {
      readonly name: string;
      readonly type: C.SpaceViewType;
    },
  ) =>
    service.createView({
      ...common,
      mutationId: kit.next("view"),
      dataSourceId: created.dataSourceId,
      ...input,
    });
  const update = (viewId: C.SpaceViewId, patch: Partial<C.SpaceViewUpdateInput>) =>
    service.updateView({ ...common, mutationId: kit.next("update-view"), viewId, ...patch });
  const views = Effect.map(kit.get(created.databaseId), (got) => got.views);
  return {
    service,
    common,
    page,
    kit,
    created,
    points,
    tag,
    when,
    calc,
    attach,
    label,
    create,
    update,
    views,
  };
});

const blockViewIds = (dbPath: string, blockId: string) =>
  raw(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{
        readonly payload: string;
      }>`SELECT payload FROM spaces_blocks WHERE block_id = ${blockId}`;
      return (JSON.parse(row!.payload) as { content: { viewIds: string[] } }).content.viewIds;
    }),
  );

it.layer(NodeServices.layer)("Spaces database views", (it) => {
  it.effect(
    "stores view configuration, patches fields independently, and merges per-column settings",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { points, tag, when, create, update, views, created } = yield* setup();
          const board = yield* create({
            name: "Board",
            type: "board",
            filter: {
              and: [
                { property: points, operator: "greater_than", value: 1 },
                { or: [{ property: tag, operator: "is_empty" }] },
              ],
            },
            sorts: [{ property: points, direction: "descending" }],
            group: { property: tag, by: "option", sort: "manual" },
            properties: [
              { propertyId: pid("title"), visible: true },
              { propertyId: points, visible: false, width: 90 },
            ],
            layout: { cardSize: "small", cardPreview: { kind: "property", propertyId: points } },
            beforeViewId: created.viewId,
          });
          let got = yield* views;
          assert.deepEqual(
            got.map((view) => view.id),
            [board.viewId, created.viewId],
          );
          const stored = got[0]!;
          assert.equal(stored.type, "board");
          assert.deepEqual(stored.group, { property: tag, by: "option", sort: "manual" });
          assert.deepEqual(stored.layout, {
            cardSize: "small",
            cardPreview: { kind: "property", propertyId: points },
          });
          yield* update(board.viewId, { name: "Renamed" });
          yield* update(board.viewId, { sorts: [] });
          yield* update(board.viewId, { filter: null });
          got = yield* views;
          assert.equal(got[0]!.name, "Renamed");
          assert.deepEqual(got[0]!.sorts, []);
          assert.isUndefined(got[0]!.filter);
          assert.deepEqual(got[0]!.group, { property: tag, by: "option", sort: "manual" });
          // Two writers resizing different columns both win.
          yield* Effect.all(
            [
              update(board.viewId, { properties: { set: { [points]: { width: 140 } } } }),
              update(board.viewId, {
                properties: {
                  set: {
                    [tag]: { width: 60, visible: true, aggregate: "count_values" },
                    [when]: { visible: true },
                  },
                },
              }),
            ],
            { concurrency: "unbounded" },
          );
          got = yield* views;
          const byId = new Map(got[0]!.properties.map((column) => [column.propertyId, column]));
          assert.deepEqual(byId.get(points), { propertyId: points, visible: false, width: 140 });
          assert.deepEqual(byId.get(tag), {
            propertyId: tag,
            visible: true,
            width: 60,
            aggregate: "count_values",
          });
          yield* update(board.viewId, {
            properties: { set: { [points]: null, [tag]: { width: null, aggregate: null } } },
          });
          yield* update(board.viewId, { properties: { order: [when, pid("title")] } });
          got = yield* views;
          assert.deepEqual(
            got[0]!.properties.map((column) => column.propertyId),
            [when, pid("title"), tag],
          );
          assert.deepEqual(got[0]!.properties[2], { propertyId: tag, visible: true });
          // Changing the type revalidates the stored layout: board-only keys do not carry over.
          yield* update(board.viewId, { type: "table" });
          got = yield* views;
          assert.equal(got[0]!.type, "table");
          assert.deepEqual(got[0]!.layout, {});
          const unsorted = yield* update(board.viewId, { group: null });
          assert.equal(unsorted.status, "saved");
        }),
      ),
  );

  it.effect("rejects invalid view definitions with the specified errors", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { points, tag, when, calc, attach, label, create } = yield* setup();
        const reason = (effect: Effect.Effect<unknown, C.SpaceServiceError>) =>
          Effect.map(databaseError(effect), (error) => error.reason);
        assert.equal(
          yield* reason(create({ name: "x", type: "table", layout: { nonsense: true } })),
          "invalid_view",
        );
        assert.equal(yield* reason(create({ name: "x", type: "calendar" })), "invalid_view");
        assert.equal(
          yield* reason(
            create({ name: "x", type: "calendar", layout: { datePropertyId: points } }),
          ),
          "invalid_view",
        );
        assert.equal(
          yield* reason(
            create({
              name: "x",
              type: "timeline",
              layout: { startPropertyId: when, endPropertyId: label },
            }),
          ),
          "invalid_view",
        );
        const calendar = yield* create({
          name: "Cal",
          type: "calendar",
          layout: { datePropertyId: when, mode: "week" },
        });
        assert.equal(calendar.status, "saved");
        assert.equal(
          yield* reason(
            create({
              name: "x",
              type: "table",
              sorts: [{ property: calc, direction: "ascending" }],
            }),
          ),
          "property_not_queryable",
        );
        assert.equal(
          yield* reason(create({ name: "x", type: "table", group: { property: calc } })),
          "property_not_queryable",
        );
        assert.equal(
          yield* reason(create({ name: "x", type: "board", group: { property: attach } })),
          "invalid_group",
        );
        assert.equal(
          yield* reason(create({ name: "x", type: "board", group: { property: tag, by: "day" } })),
          "invalid_group",
        );
        assert.equal(
          yield* reason(
            create({
              name: "x",
              type: "board",
              group: { property: tag },
              subGroup: { property: tag },
            }),
          ),
          "invalid_group",
        );
        assert.equal(
          yield* reason(
            create({
              name: "x",
              type: "table",
              properties: [{ propertyId: label, visible: true, aggregate: "sum" }],
            }),
          ),
          "invalid_aggregate",
        );
        assert.equal(
          yield* reason(
            create({
              name: "x",
              type: "table",
              filter: { property: points, operator: "contains", value: "x" },
            }),
          ),
          "operator_not_supported",
        );
        assert.equal(
          yield* reason(
            create({
              name: "x",
              type: "table",
              filter: { property: points, operator: "equals", value: "x" },
            }),
          ),
          "invalid_filter",
        );
        assert.equal(
          yield* reason(
            create({
              name: "x",
              type: "table",
              filter: { property: tag, operator: "equals", value: "nope" },
            }),
          ),
          "unknown_option",
        );
        assert.equal(
          yield* reason(
            create({
              name: "x",
              type: "table",
              filter: { property: when, operator: "before", value: "tomorrowish" },
            }),
          ),
          "invalid_filter",
        );
        // A computed property without a query type (here: it reads the clock) cannot be filtered.
        assert.equal(
          yield* reason(
            create({
              name: "Calc",
              type: "table",
              filter: { property: calc, operator: "equals", value: 1 },
            }),
          ),
          "property_not_queryable",
        );
        const unknown = yield* Effect.flip(
          create({
            name: "x",
            type: "table",
            filter: { property: pid("ghost"), operator: "equals", value: 1 },
          }),
        );
        assert.equal(unknown._tag, "SpaceNotFoundError");
        // Filter shape limits.
        const leaf = { property: points, operator: "equals" as const, value: 1 };
        const nest = (depth: number): C.SpaceKnownFilter =>
          depth === 0 ? leaf : { and: [nest(depth - 1)] };
        assert.equal(
          (yield* create({ name: "deep", type: "table", filter: nest(2) })).status,
          "saved",
        );
        assert.equal(
          yield* limitError(create({ name: "x", type: "table", filter: nest(4) })),
          "databases.maxFilterDepth",
        );
        assert.equal(
          yield* limitError(
            create({
              name: "x",
              type: "table",
              filter: { and: Array.from({ length: 51 }, () => leaf) },
            }),
          ),
          "databases.maxFilterConditions",
        );
        assert.equal(
          yield* limitError(
            create({
              name: "x",
              type: "table",
              filter: {
                and: Array.from({ length: 12 }, () => ({
                  property: label,
                  operator: "contains" as const,
                  value: "v".repeat(1_500),
                })),
              },
            }),
          ),
          "databases.maxViewBytes",
        );
        assert.equal(
          yield* limitError(
            create({
              name: "x",
              type: "table",
              sorts: Array.from({ length: 9 }, () => ({
                property: points,
                direction: "ascending" as const,
              })),
            }),
          ),
          "databases.maxSorts",
        );
      }),
    ),
  );

  it.effect("keeps the last view, enforces the view quota, and edits the block's tab list", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, page, create, update, created } = yield* setup();
        const home = created.block!.blockId;
        const target = { pageId: page.id, blockId: home };
        const revisionBefore = (yield* service.getPage({ ...env, pageId: page.id })).page.revision;
        const added = yield* create({ name: "Second", type: "list", block: target });
        assert.deepEqual(added.block, {
          pageId: page.id,
          blockId: home,
          revision: revisionBefore + 1,
        });
        assert.deepEqual(yield* blockViewIds(dbPath, home), [created.viewId, added.viewId]);
        const removed = yield* service.deleteView({
          ...common,
          mutationId: "delete-second",
          viewId: added.viewId,
          block: target,
        });
        assert.equal(removed.block?.revision, revisionBefore + 2);
        assert.deepEqual(yield* blockViewIds(dbPath, home), [created.viewId]);
        const last = yield* databaseError(
          service.deleteView({ ...common, mutationId: "delete-last-view", viewId: created.viewId }),
        );
        assert.equal(last.reason, "last_view");
        // A block of another database, or a stranger block, is refused.
        const other = yield* service.createDatabase({
          ...common,
          mutationId: "other-db",
          spaceId: page.spaceId,
          title: "Other",
          appendToPageId: page.id,
        });
        const wrong = yield* databaseError(
          create({
            name: "Wrong",
            type: "table",
            block: { pageId: page.id, blockId: other.block!.blockId },
          }),
        );
        assert.equal(wrong.reason, "invalid_view");
        const stranger = yield* Effect.flip(
          create({
            name: "Stranger",
            type: "table",
            block: { pageId: page.id, blockId: C.SpaceBlockId.make("nope") },
          }),
        );
        assert.equal(stranger._tag, "SpaceNotFoundError");
        for (let i = 0; i < 49; i++) yield* create({ name: `View ${i}`, type: "table" });
        assert.equal(
          yield* limitError(create({ name: "Overflow", type: "table" })),
          "databases.maxViewsPerDatabase",
        );
        const gone = yield* Effect.flip(update(C.SpaceViewId.make("missing"), { name: "x" }));
        assert.equal(gone._tag, "SpaceNotFoundError");
      }),
    ),
  );

  it.effect("keeps a view patchable after a property its layout names is removed", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, created, when, label, create, update, views } = yield* setup();
        const calendar = yield* create({
          name: "Cal",
          type: "calendar",
          layout: { datePropertyId: when },
        });
        const gallery = yield* create({
          name: "Gal",
          type: "gallery",
          layout: { cardPreview: { kind: "property", propertyId: label } },
        });
        yield* kit.schema(created.dataSourceId, [
          { op: "removeProperty", propertyId: when },
          { op: "removeProperty", propertyId: label },
        ]);
        yield* update(calendar.viewId, { name: "Renamed" });
        yield* update(gallery.viewId, { name: "Renamed too" });
        const after = yield* views;
        const galleryLayout = after.find((view) => view.id === gallery.viewId)!.layout;
        assert.isUndefined((galleryLayout as { cardPreview?: unknown }).cardPreview);
        assert.equal(after.find((view) => view.id === calendar.viewId)!.name, "Renamed");
        // Naming the dead property again in the layout is still refused.
        const stale = yield* Effect.flip(
          update(calendar.viewId, { layout: { datePropertyId: when } }),
        );
        assert.equal(stale._tag, "SpaceNotFoundError");
      }),
    ),
  );
});
