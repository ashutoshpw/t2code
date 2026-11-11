import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../../config.ts";
import { layerTest, sharedDatabase } from "../PageShareDatabases.testkit.ts";
import {
  SCALE_ROWS,
  SMALL_ROWS,
  type Scale,
  buildScale,
  bytesOf,
  observe,
  p,
  plansOf,
  report,
  scans,
} from "./DatabaseScale.testkit.ts";

const SHARED_FLAT_ROWS = 50;
const SHARED_BUCKET_ROWS = 10;
const COVERS = 50;

it.effect("serves shared windows and row assets in statements that do not grow", () =>
  Effect.gen(function* () {
    const f = yield* sharedDatabase();
    const { spacesDbPath: dbPath } = yield* ServerConfig.ServerConfig;
    const host = {
      service: f.spaces,
      common: f.common,
      spaceId: f.spaceId,
      appendToPageId: f.host,
      dbPath,
      kit: f.kit,
    };
    const large = yield* buildScale(host, { prefix: "big", rows: SCALE_ROWS, bodies: 0 });
    const small = yield* buildScale(host, { prefix: "small", rows: SMALL_ROWS, bodies: 0 });
    const board = (scale: Scale) =>
      f.spaces.createView({
        ...f.common,
        mutationId: f.kit.next("board"),
        dataSourceId: scale.dataSourceId,
        name: "Board",
        type: "board",
        beforeViewId: null,
        group: { property: p.s200 },
        block: { pageId: f.host, blockId: scale.blockId! },
      });
    const boards = new Map<Scale, C.SpaceViewId>();
    for (const scale of [large, small]) boards.set(scale, (yield* board(scale)).viewId);
    const failures: string[] = [];
    const counts = new Map<string, number[]>();
    const check = Effect.fn("DatabaseScaleSharedTest.check")(function* <E>(
      name: string,
      read: (scale: Scale) => Effect.Effect<
        {
          readonly rows: readonly unknown[];
          readonly groups?: readonly { readonly rows: readonly unknown[] }[];
        },
        E
      >,
    ) {
      const per = [];
      for (const scale of [large, small]) {
        const seen = yield* observe(read(scale));
        per.push(seen.statements.length);
        const found = yield* scans(dbPath, seen.statements);
        const plans = yield* plansOf(dbPath, seen.statements);
        report(`shared ${name} ${scale.prefix}`, {
          statements: seen.statements.length,
          bytes: bytesOf(seen.result),
          scans: found,
          rows: seen.result.rows.length,
          plans: plans.length,
        });
        if (found.length > 0) failures.push(`${name}: full scans ${found.join("; ")}`);
        if (seen.result.rows.length > SHARED_FLAT_ROWS)
          failures.push(`${name}: ${seen.result.rows.length} rows`);
        for (const bucket of seen.result.groups ?? [])
          if (bucket.rows.length > SHARED_BUCKET_ROWS)
            failures.push(`${name}: ${bucket.rows.length} rows in a bucket`);
      }
      counts.set(name, per);
      if (per[0] !== per[1])
        failures.push(
          `${name}: ${per[0]} statements at ${SCALE_ROWS} rows, ${per[1]} at ${SMALL_ROWS}`,
        );
    });
    yield* check("flat window", (scale) =>
      f.shares.databaseQuery(f.token, { blockId: scale.blockId!, viewId: scale.viewId }),
    );
    yield* check("board", (scale) =>
      f.shares.databaseQuery(f.token, { blockId: scale.blockId!, viewId: boards.get(scale)! }),
    );
    yield* check("row page", (scale) =>
      Effect.map(
        f.shares.databaseRow(f.token, {
          blockId: scale.blockId!,
          viewId: scale.viewId,
          rowId: scale.taskId(7),
        }),
        (page) => ({ rows: [page.row] }),
      ),
    );

    // Row assets: 50 covers, each request the same statements, at any size.
    const asset = yield* f.uploadImage("cover");
    for (const scale of [large, small])
      for (let i = 1; i <= (scale === large ? COVERS : 1); i++)
        yield* f.attachImage(scale.taskId(i), `cover-${scale.prefix}-${i}`, asset);
    const perRequest = new Map<string, number[]>();
    for (const scale of [large, small])
      for (let i = 1; i <= (scale === large ? COVERS : 1); i++) {
        const seen = yield* observe(
          f.shares.asset(f.token, undefined, asset, {
            blockId: scale.blockId!,
            viewId: scale.viewId,
            rowId: scale.taskId(i),
          }),
        );
        assert.equal(seen.result.mimeType, "image/png");
        perRequest.set(scale.prefix, [
          ...(perRequest.get(scale.prefix) ?? []),
          seen.statements.length,
        ]);
        if (i === 1) {
          const found = yield* scans(dbPath, seen.statements);
          if (found.length > 0) failures.push(`row asset: full scans ${found.join("; ")}`);
        }
      }
    const all = [...perRequest.values()].flat();
    report("shared row asset statements per request", [...new Set(all)]);
    if (new Set(all).size !== 1 || all[0] !== 33)
      failures.push(`row asset statements differ between requests: ${[...new Set(all)]}`);
    assert.deepEqual(failures, []);
  }).pipe(Effect.provide(layerTest)),
);
