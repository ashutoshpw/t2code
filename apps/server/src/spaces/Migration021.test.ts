import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { raw } from "./service/Databases.testkit.ts";
import { boot, fixture } from "./service/Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces migration 21", (it) => {
  it.effect("finds the copies of a synced block through the partial index", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        yield* boot();
        const plan = yield* raw(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql.unsafe<{ readonly detail: string }>(
              `EXPLAIN QUERY PLAN SELECT b.block_id, b.page_id, p.title, p.icon FROM spaces_blocks b
                JOIN spaces_pages p ON p.page_id = b.page_id
                WHERE b.deleted = 0 AND json_extract(b.payload, '$.type') = 'synced_ref'
                  AND json_extract(b.payload, '$.content.sourceBlockId') = ?
                  AND p.trash_batch_id IS NULL
                ORDER BY p.title, b.block_id LIMIT 20`,
              ["source"],
            );
          }),
        );
        assert.isTrue(
          plan.some((row) => row.detail.includes("USING INDEX spaces_blocks_synced_source")),
          plan.map((row) => row.detail).join("\n"),
        );
      }),
    ),
  );
});
