import * as Effect from "effect/Effect";
import * as SpacesSql from "../SpacesSql.ts";

// Purely additive: value indexes so a number or date comparison seeks the matching cells
// instead of reading every cell of the property.
export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`CREATE INDEX spaces_db_cells_num
    ON spaces_db_cells(data_source_id, property_id, num) WHERE num IS NOT NULL`;
  yield* sql`CREATE INDEX spaces_db_cells_time
    ON spaces_db_cells(data_source_id, property_id, time_start) WHERE time_start IS NOT NULL`;
});
