import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

// Purely additive: finds the copies of a synced block without scanning every block.
export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`CREATE INDEX spaces_blocks_synced_source
    ON spaces_blocks(json_extract(payload, '$.content.sourceBlockId'))
    WHERE deleted = 0 AND json_extract(payload, '$.type') = 'synced_ref'`;
});
