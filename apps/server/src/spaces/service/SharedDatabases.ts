import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import * as Catalog from "../assets/Catalog.ts";
import * as Read from "../sharedDatabases/Read.ts";
import { assetErrors, assetMetadata } from "./Helpers.ts";
import type * as Assets from "./Assets.ts";
import type { Runtime } from "./Runtime.ts";

/**
 * Public database reads. Every method takes the share's root page from an already authorized
 * link and uses `rt.read` only: no write lock, no clock write, no mutation admission. Cursors in
 * and out are the raw engine cursors; the share service seals them.
 */
export const make = (rt: Runtime, { openAssetFile }: Pick<Assets.Assets, "openAssetFile">) => {
  const { admit, read } = rt;
  const describeSharedDatabase = Effect.fn("SpacesService.describeSharedDatabase")(
    function* (input: {
      readonly rootPageId: C.SpacePageId;
      readonly pageId: C.SpacePageId;
      readonly blockId: C.SpaceBlockId;
    }) {
      const environmentId = yield* admit();
      return yield* read(environmentId, () =>
        Read.describe(input.rootPageId, input.pageId, input.blockId),
      );
    },
  );
  const querySharedDatabase = Effect.fn("SpacesService.querySharedDatabase")(function* (input: {
    readonly rootPageId: C.SpacePageId;
    readonly pageId: C.SpacePageId;
    readonly blockId: C.SpaceBlockId;
    readonly viewId: C.SpaceViewId;
    readonly params: Read.QueryParams;
  }) {
    const environmentId = yield* admit();
    return yield* read(environmentId, (meta) =>
      Read.query({ ...input, environmentId, nowMs: meta.observed_time_ms }),
    );
  });
  const readSharedDatabaseRow = Effect.fn("SpacesService.readSharedDatabaseRow")(function* (input: {
    readonly rootPageId: C.SpacePageId;
    readonly pageId: C.SpacePageId;
    readonly blockId: C.SpaceBlockId;
    readonly viewId: C.SpaceViewId;
    readonly rowId: C.SpacePageId;
    readonly cursor?: string;
    readonly timeZone?: string;
  }) {
    const environmentId = yield* admit();
    return yield* read(environmentId, (meta) =>
      Read.readRow({ ...input, environmentId, nowMs: meta.observed_time_ms }),
    );
  });
  const resolveSharedRowAssetFile = Effect.fn("SpacesService.resolveSharedRowAssetFile")(
    function* (input: {
      readonly rootPageId: C.SpacePageId;
      readonly pageId: C.SpacePageId;
      readonly blockId: C.SpaceBlockId;
      readonly viewId: C.SpaceViewId;
      readonly rowId: C.SpacePageId;
      readonly assetId: C.SpaceAssetId;
    }) {
      const environmentId = yield* admit();
      const row = yield* read(environmentId, (meta) =>
        Effect.gen(function* () {
          if (
            !(yield* Read.assertRowAsset({ ...input, environmentId, nowMs: meta.observed_time_ms }))
          )
            return yield* new C.SpaceAssetError({ reason: "not_found" });
          return yield* Catalog.readyAsset(input.assetId).pipe(assetErrors);
        }),
      );
      return yield* openAssetFile(assetMetadata(row));
    },
  );
  return {
    describeSharedDatabase,
    querySharedDatabase,
    readSharedDatabaseRow,
    resolveSharedRowAssetFile,
  };
};
