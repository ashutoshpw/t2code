import * as Effect from "effect/Effect";

import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`ALTER TABLE spaces_pages ADD COLUMN trash_batch_id TEXT`;
  yield* sql`ALTER TABLE spaces_pages ADD COLUMN trash_root_id TEXT`;
  yield* sql`ALTER TABLE spaces_pages ADD COLUMN trashed_at_ms INTEGER`;
  yield* sql`ALTER TABLE spaces_pages ADD COLUMN trash_origin TEXT CHECK (
    (trash_batch_id IS NULL AND trash_root_id IS NULL AND trashed_at_ms IS NULL AND trash_origin IS NULL)
    OR (trash_batch_id IS NOT NULL AND trash_root_id IS NOT NULL AND trashed_at_ms IS NOT NULL AND trash_origin IS NOT NULL)
  )`;
  yield* sql`CREATE INDEX spaces_pages_trash_batch ON spaces_pages(trash_batch_id,page_id) WHERE trash_batch_id IS NOT NULL`;
  yield* sql`CREATE INDEX spaces_pages_trash ON spaces_pages(trashed_at_ms,page_id) WHERE trash_batch_id IS NOT NULL`;
  yield* sql`CREATE INDEX spaces_pages_live_root ON spaces_pages(space_id,root_order,page_id) WHERE trash_batch_id IS NULL AND root_order IS NOT NULL`;
  yield* sql`CREATE INDEX spaces_blocks_page_identity ON spaces_blocks(page_id,block_id)`;
});
