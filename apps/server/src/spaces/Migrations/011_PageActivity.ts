import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`CREATE INDEX spaces_pages_activity ON spaces_pages(updated_at DESC, page_id ASC) WHERE trash_batch_id IS NULL`;
});
