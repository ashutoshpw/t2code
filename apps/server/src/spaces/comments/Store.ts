import { type EnvironmentId, ProjectId, RunId, ThreadId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { byteLength } from "../CorePolicy.ts";
import * as PageStore from "../PageStore.ts";
import * as ReferenceStore from "../ReferenceStore.ts";
import { cursorFor, cursorFrom } from "../service/Helpers.ts";
import * as SpacesSql from "../SpacesSql.ts";

interface ThreadRow {
  readonly thread_id: string;
  readonly page_id: string;
  readonly block_id: string;
  readonly anchor: string;
  readonly resolved_at: string | null;
  readonly created_at: string;
  readonly revision: number;
  readonly next_ordinal: number;
}
interface CommentRow {
  readonly comment_id: string;
  readonly thread_id: string;
  readonly ordinal: number;
  readonly author: string;
  readonly body: string;
  readonly created_at: string;
  readonly edited_at: string | null;
}
export interface DispatchRow {
  readonly comment_id: string;
  readonly environment_id: string;
  readonly project_id: string;
  readonly thread_id: string;
  readonly message_id: string;
  readonly run_id: string;
  readonly mode: C.SpaceCommentDispatchMode;
  readonly status: C.SpaceCommentDispatchStatus;
  readonly updated_at: string;
}
type Resolution = Pick<C.SpaceCommentThread, "anchorState" | "resolvedBlockId">;

export const encodeAnchor = Schema.encodeSync(Schema.fromJsonString(C.SpaceCommentAnchor));
export const encodeAuthor = Schema.encodeSync(Schema.fromJsonString(C.SpaceCommentAuthor));
export const encodeBody = Schema.encodeSync(Schema.fromJsonString(C.SpaceRichText));
const parseAnchor = Schema.decodeUnknownSync(Schema.fromJsonString(C.SpaceCommentAnchor));
const parseAuthor = Schema.decodeUnknownSync(Schema.fromJsonString(C.SpaceCommentAuthor));
const parseBody = Schema.decodeUnknownSync(Schema.fromJsonString(C.SpaceRichText));

const notFound = (id: string) => new C.SpaceCommentError({ reason: "not_found", id });

export const toDispatch = (row: DispatchRow): C.SpaceCommentDispatch => ({
  threadId: ThreadId.make(row.thread_id),
  projectId: ProjectId.make(row.project_id),
  runId: RunId.make(row.run_id),
  mode: row.mode,
  status: row.status,
  updatedAt: row.updated_at,
});

const toComment = (row: CommentRow, dispatch: DispatchRow | undefined): C.SpaceComment => ({
  id: C.SpaceCommentId.make(row.comment_id),
  author: parseAuthor(row.author),
  body: parseBody(row.body),
  createdAt: row.created_at,
  editedAt: row.edited_at,
  ...(dispatch === undefined ? {} : { dispatch: toDispatch(dispatch) }),
});

const toThread = (
  row: ThreadRow,
  comments: readonly C.SpaceComment[],
  resolution: Resolution,
): C.SpaceCommentThread => ({
  id: C.SpaceCommentThreadId.make(row.thread_id),
  pageId: C.SpacePageId.make(row.page_id),
  blockId: C.SpaceBlockId.make(row.block_id),
  ...resolution,
  anchor: parseAnchor(row.anchor),
  status: row.resolved_at === null ? "open" : "resolved",
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
  revision: row.revision,
  comments,
});

export const loadThread = Effect.fn("SpacesComments.loadThread")(function* (threadId: string) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<ThreadRow>`SELECT thread_id, page_id, block_id, anchor, resolved_at,
    created_at, revision, next_ordinal FROM spaces_comment_threads WHERE thread_id = ${threadId}`;
  if (!row) return yield* notFound(threadId);
  return row;
});

/** A comment with the thread it belongs to. */
export const loadComment = Effect.fn("SpacesComments.loadComment")(function* (commentId: string) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<CommentRow>`SELECT comment_id, thread_id, ordinal, author, body,
    created_at, edited_at FROM spaces_comments WHERE comment_id = ${commentId}`;
  if (!row) return yield* notFound(commentId);
  return { comment: row, thread: yield* loadThread(row.thread_id) };
});

export const pageCommentRevision = Effect.fn("SpacesComments.pageRevision")(function* (
  pageId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<{
    readonly comment_revision: number;
  }>`SELECT comment_revision FROM spaces_comment_pages WHERE page_id = ${pageId}`;
  return row?.comment_revision ?? 0;
});

const findDispatches = Effect.fn("SpacesComments.findDispatches")(function* (
  commentIds: readonly string[],
) {
  const sql = yield* SpacesSql.SpacesSql;
  if (commentIds.length === 0) return new Map<string, DispatchRow>();
  const rows = yield* sql<DispatchRow>`SELECT * FROM spaces_comment_dispatches
    WHERE comment_id IN ${sql.in(commentIds)}`;
  return new Map(rows.map((row) => [row.comment_id, row]));
});

const resolution = Effect.fn("SpacesComments.resolution")(function* (row: ThreadRow) {
  const found = yield* ReferenceStore.resolve({
    kind: "block",
    blockId: C.SpaceBlockId.make(row.block_id),
  });
  if (found.status === "resolved" && found.page.id === row.page_id)
    return { anchorState: "live", resolvedBlockId: C.SpaceBlockId.make(row.block_id) } as const;
  if (found.status === "merged" && found.page.id === row.page_id)
    return { anchorState: "merged", resolvedBlockId: found.blockId } as const;
  return { anchorState: "detached" } as const;
});

/** Builds threads with their comments and dispatches in two queries for the whole window. */
const hydrate = Effect.fn("SpacesComments.hydrate")(function* (rows: readonly ThreadRow[]) {
  const sql = yield* SpacesSql.SpacesSql;
  if (rows.length === 0) return [];
  const comments = yield* sql<CommentRow>`SELECT comment_id, thread_id, ordinal, author, body,
    created_at, edited_at FROM spaces_comments
    WHERE thread_id IN ${sql.in(rows.map((row) => row.thread_id))} ORDER BY thread_id, ordinal`;
  const dispatches = yield* findDispatches(comments.map((row) => row.comment_id));
  const byThread = new Map<string, C.SpaceComment[]>();
  for (const row of comments) {
    const list = byThread.get(row.thread_id) ?? [];
    list.push(toComment(row, dispatches.get(row.comment_id)));
    byThread.set(row.thread_id, list);
  }
  const threads: C.SpaceCommentThread[] = [];
  for (const row of rows)
    threads.push(toThread(row, byThread.get(row.thread_id) ?? [], yield* resolution(row)));
  return threads;
});

export const listThread = Effect.fn("SpacesComments.listThread")(function* (threadId: string) {
  const row = yield* loadThread(threadId);
  const [thread] = yield* hydrate([row]);
  return thread!;
});

export const listPage = Effect.fn("SpacesComments.listPage")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly pageId: C.SpacePageId;
  readonly status: "open" | "resolved";
  readonly cursor: C.SpaceCursor | undefined;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* PageStore.load(input.pageId);
  const revision = yield* pageCommentRevision(input.pageId);
  const cursor = yield* cursorFrom(
    input.cursor,
    input.environmentId,
    "listComments",
    `${input.pageId}:${input.status}`,
    revision,
  );
  const limit = C.SPACE_COMMENT_LIMITS.listThreads + 1;
  // The open list ascends by creation and the resolved list descends by resolution; an absent
  // cursor starts before the first row in either order.
  const rows =
    input.status === "open"
      ? yield* sql<ThreadRow>`SELECT thread_id, page_id, block_id, anchor, resolved_at, created_at,
          revision, next_ordinal FROM spaces_comment_threads
          WHERE page_id = ${input.pageId} AND resolved_at IS NULL
            AND (created_at > ${cursor?.key ?? ""}
              OR (created_at = ${cursor?.key ?? ""} AND thread_id > ${cursor?.id ?? ""}))
          ORDER BY created_at, thread_id LIMIT ${limit}`
      : yield* sql<ThreadRow>`SELECT thread_id, page_id, block_id, anchor, resolved_at, created_at,
          revision, next_ordinal FROM spaces_comment_threads
          WHERE page_id = ${input.pageId} AND resolved_at IS NOT NULL
            AND (resolved_at < ${cursor?.key ?? "￿"}
              OR (resolved_at = ${cursor?.key ?? "￿"} AND thread_id > ${cursor?.id ?? ""}))
          ORDER BY resolved_at DESC, thread_id LIMIT ${limit}`;
  const window = rows.slice(0, C.SPACE_COMMENT_LIMITS.listThreads);
  const hydrated = yield* hydrate(window);
  const threads: C.SpaceCommentThread[] = [];
  let bytes = 0;
  for (const thread of hydrated) {
    bytes += byteLength(thread);
    if (threads.length > 0 && bytes > C.SPACE_COMMENT_LIMITS.maxListResponseBytes) break;
    threads.push(thread);
  }
  const last = window[threads.length - 1];
  const more = threads.length < rows.length;
  const nextCursor =
    more && last !== undefined
      ? yield* cursorFor(
          input.environmentId,
          "listComments",
          `${input.pageId}:${input.status}`,
          revision,
          (input.status === "open" ? last.created_at : last.resolved_at) ?? "",
          last.thread_id,
        )
      : null;
  return { commentRevision: revision, threads, nextCursor };
});
