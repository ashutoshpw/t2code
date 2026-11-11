import { assert, it } from "@effect/vitest";
import {
  SPACE_PAGE_SHARE_ASSET_ROUTE,
  SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE,
  SPACE_PAGE_SHARE_DATABASE_ROUTE,
  SPACE_PAGE_SHARE_DATABASE_ROW_ROUTE,
  SpaceSharedDatabase,
  SpaceSharedDatabaseRowPage,
  SpaceSharedDatabaseWindow,
} from "@t2code/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { httpHarness, ids, layerTest, sharedDatabase } from "./PageShareDatabases.testkit.ts";

const decodeDatabase = Schema.decodeUnknownEffect(SpaceSharedDatabase);
const decodeWindow = Schema.decodeUnknownEffect(SpaceSharedDatabaseWindow);
const decodeRowPage = Schema.decodeUnknownEffect(SpaceSharedDatabaseRowPage);
const decodeFailure = Schema.decodeUnknownSync(Schema.Struct({ reason: Schema.String }));
const reasonOf = (response: Response) =>
  Effect.promise(async () => decodeFailure(await response.json()).reason);

it.effect("serves the three database routes with the token in the header only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* sharedDatabase();
      const { get } = yield* httpHarness();
      const block = { block: f.blockId, view: f.viewId };
      const row = { ...block, row: f.rowIds[0]! };

      const described = yield* get(SPACE_PAGE_SHARE_DATABASE_ROUTE, { block: f.blockId }, f.token);
      assert.equal(described.status, 200);
      assert.equal(described.headers.get("cache-control"), "no-store");
      assert.lengthOf(
        (yield* decodeDatabase(yield* Effect.promise(() => described.json()))).views,
        1,
      );
      const window = yield* get(SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE, block, f.token);
      assert.equal(window.status, 200);
      assert.lengthOf((yield* decodeWindow(yield* Effect.promise(() => window.json()))).rows, 3);
      const page = yield* get(SPACE_PAGE_SHARE_DATABASE_ROW_ROUTE, row, f.token);
      assert.equal(page.status, 200);
      assert.equal(
        (yield* decodeRowPage(yield* Effect.promise(() => page.json()))).row.title,
        "Row one",
      );

      // The credential in a query parameter is ignored: no header, no request.
      for (const [route, params] of [
        [SPACE_PAGE_SHARE_DATABASE_ROUTE, { block: f.blockId }],
        [SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE, block],
        [SPACE_PAGE_SHARE_DATABASE_ROW_ROUTE, row],
      ] as const) {
        const refused = yield* get(route, { ...params, share: f.token });
        assert.equal(refused.status, 400);
        assert.equal(refused.headers.get("cache-control"), "no-store");
      }
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("maps refusals to statuses and bad parameters to 400", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* sharedDatabase();
      const { get } = yield* httpHarness();
      const block = { block: f.blockId, view: f.viewId };
      const cases: ReadonlyArray<readonly [string, Record<string, string>, string, number]> = [
        [SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE, { ...block, view: "nope" }, f.token, 403],
        [SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE, block, `${f.token}x`, 403],
        [SPACE_PAGE_SHARE_DATABASE_ROW_ROUTE, { ...block, row: "nope" }, f.token, 403],
        [SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE, { block: f.blockId }, f.token, 400],
        [SPACE_PAGE_SHARE_DATABASE_ROW_ROUTE, block, f.token, 400],
        [SPACE_PAGE_SHARE_DATABASE_ROUTE, {}, f.token, 400],
        [
          SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE,
          { ...block, from: "2026-11-01", to: "2026-11-30" },
          f.token,
          400,
        ],
        [SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE, { ...block, group: "x".repeat(513) }, f.token, 400],
        [
          SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE,
          { ...block, cursor: "x".repeat(8_193) },
          f.token,
          400,
        ],
        [SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE, { ...block, tz: "x".repeat(513) }, f.token, 400],
        [SPACE_PAGE_SHARE_DATABASE_ROUTE, { block: "x".repeat(513) }, f.token, 400],
      ];
      for (const [route, params, token, status] of cases) {
        const response = yield* get(route, params, token);
        assert.equal(response.status, status, `${route} ${JSON.stringify(params).slice(0, 60)}`);
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
      // An unknown zone falls back to the server's; a forged cursor is a refusal, not a fault.
      assert.equal(
        (yield* get(
          SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE,
          { ...block, tz: "Mars/Olympus" },
          f.token,
        )).status,
        200,
      );
      const forged = yield* get(
        SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE,
        { ...block, cursor: "AAAA" },
        f.token,
      );
      assert.equal(forged.status, 403);
      assert.equal(yield* reasonOf(forged), "unavailable");
      yield* f.shares.stop({ pageId: f.host });
      const ended = yield* get(SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE, block, f.token);
      assert.equal(ended.status, 403);
      assert.equal(yield* reasonOf(ended), "inactive");
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("takes no write through a share and checks the row form of the asset route", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* sharedDatabase();
      const { get, post } = yield* httpHarness();
      yield* f.updateView(f.viewId, { filter: { property: ids.status, operator: "is_not_empty" } });
      const asset = yield* f.uploadImage("pic");
      yield* f.attachImage(f.rowIds[0]!, "pic-block", asset);
      const row = { block: f.blockId, view: f.viewId, row: f.rowIds[0]! };
      const url = (params: Record<string, string>) =>
        get(SPACE_PAGE_SHARE_ASSET_ROUTE, { share: f.token, id: asset, ...params });
      const served = yield* url(row);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get("content-security-policy"), "default-src 'none'; sandbox");
      assert.equal((yield* url({})).status, 403);
      // One or two of block, view and row is a malformed request.
      for (const partial of [
        { block: row.block },
        { view: row.view },
        { row: row.row },
        { block: row.block, view: row.view },
        { view: row.view, row: row.row },
      ])
        assert.equal((yield* url(partial)).status, 400);
      assert.equal((yield* url({ ...row, row: f.rowIds[1]! })).status, 403);
      // No route accepts a write: other methods reach nothing, and the data stays as it was.
      const before = yield* f.spaces.getDatabaseRows({
        environmentId: f.common.environmentId,
        pageId: f.rowIds[0]!,
      });
      for (const route of [
        SPACE_PAGE_SHARE_DATABASE_ROUTE,
        SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE,
        SPACE_PAGE_SHARE_DATABASE_ROW_ROUTE,
      ])
        assert.equal((yield* post(route, row, f.token)).status, 404);
      assert.deepEqual(
        (yield* f.spaces.getDatabaseRows({
          environmentId: f.common.environmentId,
          pageId: f.rowIds[0]!,
        })).row,
        before.row,
      );
      assert.lengthOf((yield* f.shares.databaseQuery(f.token, f.request())).rows, 3);
    }),
  ).pipe(Effect.provide(layerTest)),
);
