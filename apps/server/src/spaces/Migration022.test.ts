import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { boot, fixture } from "./service/Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces migration 22", (it) => {
  it.effect("cascades comment rows with the page and lists threads through the page index", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { page } = yield* boot();
        const { plan, remaining } = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA foreign_keys = ON`;
          yield* sql`INSERT INTO spaces_comment_pages (page_id, comment_revision) VALUES (${page.id}, 1)`;
          yield* sql`INSERT INTO spaces_comment_threads (thread_id, page_id, block_id, anchor, created_at)
              VALUES ('t', ${page.id}, 'b', '{"kind":"block"}', 'now')`;
          yield* sql`INSERT INTO spaces_comments (comment_id, thread_id, ordinal, author, body, created_at)
              VALUES ('c', 't', 0, '{"kind":"user"}', '[]', 'now')`;
          const plan = yield* sql.unsafe<{ readonly detail: string }>(
            `EXPLAIN QUERY PLAN SELECT thread_id FROM spaces_comment_threads
                WHERE page_id = ? AND resolved_at IS NULL ORDER BY created_at, thread_id LIMIT 51`,
            [page.id],
          );
          yield* sql`DELETE FROM spaces_revisions WHERE page_id = ${page.id}`;
          yield* sql`DELETE FROM spaces_pages WHERE page_id = ${page.id}`;
          const remaining = yield* sql<{ readonly n: number }>`SELECT
              (SELECT COUNT(*) FROM spaces_comment_threads) + (SELECT COUNT(*) FROM spaces_comments)
              + (SELECT COUNT(*) FROM spaces_comment_pages) AS n`;
          return { plan, remaining: remaining[0]!.n };
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })), Effect.orDie);
        assert.equal(remaining, 0);
        assert.isTrue(
          plan.some((row) => row.detail.includes("USING INDEX spaces_comment_threads_page")),
          plan.map((row) => row.detail).join("\n"),
        );
      }),
    ),
  );
});
