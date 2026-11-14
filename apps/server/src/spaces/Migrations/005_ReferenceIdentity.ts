import * as Effect from "effect/Effect";

import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`ALTER TABLE spaces_ids ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))`;
  yield* sql`ALTER TABLE spaces_ids ADD COLUMN merged_into TEXT`;
  yield* sql`ALTER TABLE spaces_core ADD COLUMN reference_cursor TEXT`;
  yield* sql`CREATE INDEX spaces_ids_predecessors ON spaces_ids(merged_into,id) WHERE merged_into IS NOT NULL`;
  yield* sql`CREATE INDEX spaces_ids_redirects ON spaces_ids(id) WHERE deleted=1 AND merged_into IS NOT NULL`;
  yield* sql`CREATE INDEX spaces_blocks_retired ON spaces_blocks(block_id) WHERE deleted=1`;
  yield* sql`CREATE INDEX spaces_blocks_predecessors ON spaces_blocks(merged_into,block_id) WHERE deleted=1 AND merged_into IS NOT NULL`;
});
