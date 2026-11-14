import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { boot, env, fixture, recoveryIntent } from "./Spaces.testkit.ts";
import { databaseKit, exec } from "./Databases.testkit.ts";

const ASSET = C.SpaceAssetId.make("0b0c0d0e-0000-4000-8000-000000000001");

it.layer(NodeServices.layer)("Spaces database row extras", (it) => {
  it.effect("counts live children only under a parent scope", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Tree", { appendToPageId: page.id });
        const source = created.dataSourceId;
        const [top, kid, gone, lone] = (yield* kit.addRows(source, [
          { title: "top" },
          { title: "kid" },
          { title: "gone" },
          { title: "lone" },
        ])).rows.map((row) => row.pageId);
        const parent = (yield* kit.schema(source, [
          {
            op: "addProperty",
            property: {
              name: "Parent",
              type: "relation",
              config: { dataSourceId: source, limit: "one", twoWay: { propertyId: "kids01" } },
            },
          },
        ])).created[0]!.propertyId!;
        yield* service.updateDataSource({
          ...common,
          mutationId: "sub",
          dataSourceId: source,
          subItems: { parentPropertyId: parent },
        });
        yield* kit.setCells(source, kid!, { [parent]: [top!] });
        yield* kit.setCells(source, gone!, { [parent]: [top!] });
        const query = (scope?: object) =>
          service.queryDatabase({
            ...env,
            dataSourceId: source,
            mode: "rows",
            timeZone: "UTC",
            ...(scope === undefined ? {} : { scope }),
          });
        const counts = (r: C.SpaceDatabaseQueryResult) =>
          r.rows.map((row) => [row.page.title, row.childCount]);
        assert.deepEqual(counts(yield* query({ parentRowId: null })), [
          ["top", 2],
          ["lone", 0],
        ]);
        yield* service.trashPage(yield* recoveryIntent(service, common, gone!, "trash", "t-gone"));
        assert.deepEqual(counts(yield* query({ parentRowId: null })), [
          ["top", 1],
          ["lone", 0],
        ]);
        assert.deepEqual(counts(yield* query({ parentRowId: top! })), [["kid", 0]]);
        assert.isTrue((yield* query()).rows.every((row) => row.childCount === undefined));
        assert.isDefined(lone);
      }),
    ),
  );

  it.effect("does not count another data source's cells that reuse the parent property id", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Tree", { appendToPageId: page.id });
        const source = created.dataSourceId;
        const [top, kid] = (yield* kit.addRows(source, [
          { title: "top" },
          { title: "kid" },
        ])).rows.map((row) => row.pageId);
        const parent = (yield* kit.schema(source, [
          {
            op: "addProperty",
            property: {
              name: "Parent",
              type: "relation",
              config: { dataSourceId: source, limit: "one", twoWay: { propertyId: "kids01" } },
            },
          },
        ])).created[0]!.propertyId!;
        yield* service.updateDataSource({
          ...common,
          mutationId: "sub",
          dataSourceId: source,
          subItems: { parentPropertyId: parent },
        });
        yield* kit.setCells(source, kid!, { [parent]: [top!] });
        const other = (yield* service.createDataSource({
          ...common,
          mutationId: "other-source",
          databaseId: created.databaseId,
          name: "Other",
        })).dataSourceId;
        const [stray] = (yield* kit.addRows(other, [{ title: "stray" }])).rows.map(
          (row) => row.pageId,
        );
        yield* kit.schema(other, [
          {
            op: "addProperty",
            property: {
              id: parent,
              name: "Elsewhere",
              type: "relation",
              config: { dataSourceId: source, limit: "many", twoWay: { propertyId: "back02" } },
            },
          },
        ]);
        yield* kit.setCells(other, stray!, { [parent]: [top!] });
        const result = yield* service.queryDatabase({
          ...env,
          dataSourceId: source,
          mode: "rows",
          timeZone: "UTC",
          scope: { parentRowId: null },
        });
        assert.deepEqual(
          result.rows.map((row) => [row.page.title, row.childCount]),
          [["top", 1]],
        );
      }),
    ),
  );

  it.effect("returns the first top-level image block only when include.cover is set", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Cards", { appendToPageId: page.id });
        const made = yield* kit.addRows(created.dataSourceId, [
          { title: "with" },
          { title: "without" },
        ]);
        const withCover = made.rows[0]!.pageId;
        yield* exec(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const image = (id: string, parent: string | null, rank: string, asset: string) => {
              const payload = JSON.stringify({
                id,
                parentId: parent,
                order: rank,
                type: "image",
                version: 1,
                content: { assetId: asset },
              });
              // Saved image blocks always carry an asset reference row; the cover read relies on it.
              return sql`INSERT INTO spaces_blocks (block_id, page_id, parent_id, rank, payload, logical_bytes, deleted)
                VALUES (${id}, ${withCover}, ${parent}, ${rank}, ${payload}, ${payload.length}, 0)`.pipe(
                Effect.andThen(
                  sql`INSERT INTO spaces_block_asset_refs (block_id, asset_id) VALUES (${id}, ${asset})`,
                ),
              );
            };
            for (const id of ["img-first", "img-second", "img-nested"])
              yield* sql`INSERT INTO spaces_ids (id, kind) VALUES (${id}, 'block')`;
            yield* image("img-second", null, "2".padStart(32, "0"), "second-asset");
            yield* image("img-first", null, "1".padStart(32, "0"), ASSET);
            yield* image("img-nested", "img-first", "1".padStart(32, "0"), "nested-asset");
          }),
        );
        const query = (include?: object) =>
          service.queryDatabase({
            ...env,
            dataSourceId: created.dataSourceId,
            mode: "rows",
            timeZone: "UTC",
            ...(include === undefined ? {} : { include }),
          });
        const plain = yield* query();
        assert.isTrue(plain.rows.every((row) => row.cover === undefined));
        const rows = (yield* query({ cover: true })).rows;
        assert.deepEqual(
          rows.map((row) => row.cover),
          [{ assetId: ASSET }, undefined],
        );
        const grouped = yield* service.queryDatabase({
          ...env,
          dataSourceId: created.dataSourceId,
          mode: "groups",
          timeZone: "UTC",
          rowsPerGroup: 5,
          group: { property: C.SPACE_TITLE_PROPERTY_ID, by: "alphabetical" },
          include: { cover: true },
        });
        const first = grouped
          .groups!.flatMap((bucket) => bucket.rows)
          .find((row) => row.page.id === withCover);
        assert.deepEqual(first?.cover, { assetId: ASSET });
      }),
    ),
  );

  it.effect("returns the first body blocks of each row only when include.preview is set", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Feed", { appendToPageId: page.id });
        const source = created.dataSourceId;
        const made = yield* kit.addRows(source, [
          { title: "rich" },
          { title: "long" },
          ...Array.from({ length: 28 }, (_, index) => ({ title: `row ${index}` })),
        ]);
        const [rich, long] = made.rows.map((row) => row.pageId);
        const runs = (text: string) => [{ text, marks: [] }];
        yield* exec(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const block = (
              id: string,
              pageId: string,
              parent: string | null,
              rank: number,
              type: string,
              content: object,
            ) => {
              const order = String(rank).padStart(32, "0");
              const payload = JSON.stringify({
                id,
                parentId: parent,
                order,
                type,
                version: 1,
                content,
              });
              return sql`INSERT INTO spaces_ids (id, kind) VALUES (${id}, 'block')`.pipe(
                Effect.andThen(
                  sql`INSERT INTO spaces_blocks (block_id, page_id, parent_id, rank, payload, logical_bytes, deleted)
                    VALUES (${id}, ${pageId}, ${parent}, ${order}, ${payload}, ${payload.length}, 0)`,
                ),
              );
            };
            yield* block("b1", rich!, null, 1, "heading", { runs: runs("Title"), level: 2 });
            yield* block("b2", rich!, null, 2, "todo_item", { runs: runs("Task"), checked: true });
            yield* block("b3", rich!, null, 3, "paragraph", { runs: runs("three") });
            yield* block("b4", rich!, null, 4, "image", { assetId: "a" });
            yield* block("b5", rich!, null, 5, "paragraph", { runs: runs("five") });
            yield* block("child", rich!, "b1", 1, "paragraph", { runs: runs("nested") });
            yield* block("l1", long!, null, 1, "paragraph", { runs: runs("x".repeat(10_000)) });
          }),
        );
        const query = (extra: object) =>
          service.queryDatabase({
            ...env,
            dataSourceId: source,
            mode: "rows",
            timeZone: "UTC",
            ...extra,
          });
        assert.isTrue((yield* query({})).rows.every((row) => !("preview" in row)));
        const three = (yield* query({ include: { preview: 3 } })).rows.find(
          (row) => row.page.id === rich,
        );
        assert.deepEqual(three?.preview, {
          blocks: [
            { type: "heading", runs: runs("Title"), level: 2 },
            { type: "todo_item", runs: runs("Task"), checked: true },
            { type: "paragraph", runs: runs("three") },
          ],
          more: true,
        });
        const all = (yield* query({ include: { preview: 10 } })).rows.find(
          (row) => row.page.id === rich,
        );
        assert.deepEqual(
          all?.preview?.blocks.map((entry) => [entry.type, entry.runs.length]),
          [
            ["heading", 1],
            ["todo_item", 1],
            ["paragraph", 1],
            ["image", 0],
            ["paragraph", 1],
          ],
        );
        assert.isFalse(all?.preview?.more);
        const cut = (yield* query({ include: { preview: 1 } })).rows.find(
          (row) => row.page.id === long,
        );
        assert.equal(cut?.preview?.blocks[0]?.runs[0]?.text.length, C.SPACE_FEED_PREVIEW_ROW_BYTES);
        assert.isTrue(cut?.preview?.more);
        const window = yield* query({ include: { preview: 1 }, limit: 100 });
        assert.equal(window.rows.length, C.SPACE_FEED_WINDOW_ROWS);
        assert.isNotNull(window.nextCursor);
      }),
    ),
  );
});
