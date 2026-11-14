import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { exec } from "./service/Databases.testkit.ts";
import { boot, fixture } from "./service/Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces migration 23", (it) => {
  it.effect("a share row written without the column reads as not accepting responses", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { page } = yield* boot();
        const rows = yield* exec(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO spaces_page_shares (page_id, share_id, host, created_at, expires_at)
              VALUES (${page.id}, 'share', 'host', 'now', 'later')`;
            return yield* sql<{ readonly accept_responses: number }>`SELECT accept_responses
              FROM spaces_page_shares WHERE page_id = ${page.id}`;
          }),
        );
        assert.deepEqual(rows, [{ accept_responses: 0 }]);
      }),
    ),
  );
});
