import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { raw } from "./service/Databases.testkit.ts";
import { boot, fixture } from "./service/Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces migration 20", (it) => {
  it.effect("adds partial value indexes on number and time cells", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        yield* boot();
        const found = yield* raw(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{
              readonly name: string;
              readonly sql: string;
            }>`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('spaces_db_cells_num', 'spaces_db_cells_time') ORDER BY name`;
          }),
        );
        assert.deepEqual(
          found.map((index) => index.name),
          ["spaces_db_cells_num", "spaces_db_cells_time"],
        );
        assert.match(found[0]!.sql, /\(data_source_id, property_id, num\) WHERE num IS NOT NULL/);
        assert.match(
          found[1]!.sql,
          /\(data_source_id, property_id, time_start\) WHERE time_start IS NOT NULL/,
        );
      }),
    ),
  );
});
