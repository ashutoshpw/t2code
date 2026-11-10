import {
  type SpacePageShare,
  type SpacePageShareId,
  type SpaceSharedPage,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Catalog from "../assets/Catalog.ts";
import * as PageShares from "../PageShares.ts";
import { assetErrors, assetMetadata } from "./Helpers.ts";
import type { Runtime } from "./Runtime.ts";
import type * as Assets from "./Assets.ts";

export const make = (rt: Runtime, { openAssetFile }: Pick<Assets.Assets, "openAssetFile">) => {
  const { admit, run, read } = rt;
  const replacePageShare = Effect.fn("SpacesService.replacePageShare")(function* (
    share: SpacePageShare,
  ) {
    const environmentId = yield* admit();
    yield* run(environmentId, () => PageShares.replace(share));
  });
  const stopPageShare = Effect.fn("SpacesService.stopPageShare")(function* (pageId: C.SpacePageId) {
    const environmentId = yield* admit();
    yield* run(environmentId, () => PageShares.remove(pageId));
  });
  const findPageShare = Effect.fn("SpacesService.findPageShare")(function* (by: {
    readonly pageId: C.SpacePageId;
  }) {
    const environmentId = yield* admit();
    return yield* read(environmentId, () => PageShares.findByPage(by.pageId));
  });
  const resolvePageShare = Effect.fn("SpacesService.resolvePageShare")(function* (input: {
    readonly shareId: SpacePageShareId;
    readonly pageId?: C.SpacePageId;
  }) {
    const environmentId = yield* admit();
    return yield* read(environmentId, () => PageShares.resolve(input.shareId, input.pageId));
  });
  const readSharedPage = Effect.fn("SpacesService.readSharedPage")(function* (input: {
    readonly rootPageId: C.SpacePageId;
    readonly expiresAt: string;
    readonly pageId: C.SpacePageId;
    readonly breadcrumb: SpaceSharedPage["breadcrumb"];
    readonly cursor?: string;
  }) {
    const environmentId = yield* admit();
    return yield* read(environmentId, () =>
      PageShares.read(
        input.rootPageId,
        input.expiresAt,
        input.pageId,
        input.breadcrumb,
        input.cursor,
      ),
    );
  });
  const resolveSharedAssetFile = Effect.fn("SpacesService.resolveSharedAssetFile")(
    function* (input: { readonly pageId: C.SpacePageId; readonly assetId: C.SpaceAssetId }) {
      const environmentId = yield* admit();
      const row = yield* read(environmentId, () =>
        Effect.gen(function* () {
          if (!(yield* PageShares.referencesAsset(input.pageId, input.assetId)))
            return yield* new C.SpaceAssetError({ reason: "not_found" });
          return yield* Catalog.readyAsset(input.assetId).pipe(assetErrors);
        }),
      );
      return yield* openAssetFile(assetMetadata(row));
    },
  );
  return {
    replacePageShare,
    stopPageShare,
    findPageShare,
    resolvePageShare,
    readSharedPage,
    resolveSharedAssetFile,
  };
};
