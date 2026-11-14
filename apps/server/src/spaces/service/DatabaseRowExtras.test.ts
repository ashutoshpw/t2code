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
              return sql`INSERT INTO spaces_blocks (block_id, page_id, parent_id, rank, payload, logical_bytes, deleted)
                VALUES (${id}, ${withCover}, ${parent}, ${rank}, ${payload}, ${payload.length}, 0)`;
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
});
