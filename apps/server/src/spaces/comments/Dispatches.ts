import * as Effect from "effect/Effect";

import * as SpacesSql from "../SpacesSql.ts";
import type { DispatchRow } from "./Store.ts";

const ACTIVE_LIMIT = 200;

export const find = Effect.fn("SpacesComments.findDispatch")(function* (commentId: string) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<DispatchRow>`SELECT * FROM spaces_comment_dispatches
    WHERE comment_id = ${commentId}`;
  return row;
});

export const insert = Effect.fn("SpacesComments.insertDispatch")(function* (row: DispatchRow) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`INSERT INTO spaces_comment_dispatches
    (comment_id, environment_id, project_id, thread_id, message_id, run_id, mode, status, updated_at)
    VALUES (${row.comment_id}, ${row.environment_id}, ${row.project_id}, ${row.thread_id},
      ${row.message_id}, ${row.run_id}, ${row.mode}, ${row.status}, ${row.updated_at})`;
});

/** Moves every dispatch of a run to `status`; only active rows whose status differs are changed and returned. */
export const updateByRun = Effect.fn("SpacesComments.updateDispatchByRun")(function* (
  runId: string,
  status: DispatchRow["status"],
  nowIso: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  return yield* sql<{
    readonly comment_id: string;
    readonly page_id: string;
    readonly space_id: string;
  }>`UPDATE spaces_comment_dispatches SET status = ${status}, updated_at = ${nowIso}
    WHERE run_id = ${runId} AND status <> ${status} AND status IN ('queued', 'running')
    RETURNING comment_id,
      (SELECT t.page_id FROM spaces_comments c JOIN spaces_comment_threads t ON t.thread_id = c.thread_id
        WHERE c.comment_id = spaces_comment_dispatches.comment_id) AS page_id,
      (SELECT p.space_id FROM spaces_comments c JOIN spaces_comment_threads t ON t.thread_id = c.thread_id
        JOIN spaces_pages p ON p.page_id = t.page_id
        WHERE c.comment_id = spaces_comment_dispatches.comment_id) AS space_id`;
});

export const active = Effect.fn("SpacesComments.activeDispatches")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  return yield* sql<DispatchRow>`SELECT * FROM spaces_comment_dispatches
    WHERE status IN ('queued', 'running') ORDER BY updated_at, comment_id LIMIT ${ACTIVE_LIMIT}`;
});
