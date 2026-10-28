import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { byteLength, checkLimit } from "../CorePolicy.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as Catalog from "./Catalog.ts";
import { mediaTypes } from "./Policy.ts";

export const validate = Effect.fn("SpacesAssetReferences.validate")(function* (
  block: C.SpaceKnownBlock,
) {
  if (!("assetId" in block.content)) return;
  checkLimit("maxIdBytes", byteLength(block.content.assetId));
  const asset = yield* Catalog.readyAsset(block.content.assetId).pipe(
    Effect.catchTags({
      AssetCatalogError: (error) => Effect.fail(new C.SpaceAssetError({ reason: error.reason })),
    }),
  );
  if (mediaTypes[asset.mime_type] !== block.type)
    return yield* new C.SpaceAssetError({ reason: "media_mismatch" });
});

export const requireCurrent = Effect.fn("SpacesAssetReferences.requireCurrent")(function* (
  block: C.SpaceKnownBlock,
) {
  if (!("assetId" in block.content)) return;
  const sql = yield* SpacesSql.SpacesSql;
  const [ref] = yield* sql<{
    readonly asset_id: string;
  }>`SELECT asset_id FROM spaces_block_asset_refs
    WHERE block_id = ${block.id}`;
  if (ref?.asset_id !== block.content.assetId)
    return yield* new C.SpaceValidationError({ reason: "unsupported_block" });
});

// The caller captures old revision pins before publishing these changes in the same transaction.
export const publish = Effect.fn("SpacesAssetReferences.publish")(function* (
  changes: readonly { readonly blockId: string; readonly assetId: C.SpaceAssetId | null }[],
) {
  const sql = yield* SpacesSql.SpacesSql;
  for (const change of changes) {
    yield* sql`DELETE FROM spaces_block_asset_refs WHERE block_id = ${change.blockId}`;
    if (change.assetId !== null)
      yield* sql`INSERT INTO spaces_block_asset_refs(block_id,asset_id) VALUES (${change.blockId},${change.assetId})`;
  }
});
