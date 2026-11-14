// @effect-diagnostics nodeBuiltinImport:off -- comment ids use the platform cryptographic generator.
import * as NodeCrypto from "node:crypto";
import * as C from "@t2code/contracts/spaces";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { byteLength } from "../CorePolicy.ts";
import * as Liveness from "../databases/Liveness.ts";
import * as PageChanges from "../PageChanges.ts";
import * as PageStore from "../PageStore.ts";
import type * as Receipts from "../Receipts.ts";
import * as SpacesSql from "../SpacesSql.ts";
import { decodeReceipt } from "../service/Helpers.ts";
import { encodeAnchor, encodeAuthor, encodeBody, loadComment, loadThread } from "./Store.ts";

type Operation =
  | "createCommentThread"
  | "replyComment"
  | "agentReplyComment"
  | "editComment"
  | "deleteComment"
  | "resolveCommentThread"
  | "reopenCommentThread";
export type CommentRequest = Extract<C.SpaceMutationRequest, { readonly operation: Operation }>;

const USER_AUTHOR = encodeAuthor({ kind: "user" });

const failure = (reason: C.SpaceCommentError["reason"], id?: string) =>
  new C.SpaceCommentError({ reason, ...(id === undefined ? {} : { id }) });

/** The page must exist and be live; comments never write to the page itself. */
const livePage = Effect.fn("SpacesComments.livePage")(function* (pageId: string) {
  const page = yield* PageStore.load(C.SpacePageId.make(pageId));
  yield* PageStore.assertActive(page);
  if (!(yield* Liveness.pageLive(pageId)))
    return yield* new C.SpaceValidationError({ reason: "trashed" });
  return page;
});

/** Moves the page's comment counter and announces it; the page revision stays put. */
export const touchPage = Effect.fn("SpacesComments.touchPage")(function* (
  pageId: string,
  spaceId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<{
    readonly comment_revision: number;
  }>`INSERT INTO spaces_comment_pages (page_id, comment_revision) VALUES (${pageId}, 1)
    ON CONFLICT(page_id) DO UPDATE SET comment_revision = comment_revision + 1
    RETURNING comment_revision`;
  yield* PageChanges.recordPage(pageId, spaceId, { comments: true });
  return row!.comment_revision;
});

const bumpThread = Effect.fn("SpacesComments.bumpThread")(function* (threadId: string) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_comment_threads SET revision = revision + 1 WHERE thread_id = ${threadId}`;
});

const checkBody = (body: C.SpaceCommentBody) =>
  byteLength(body) > C.SPACE_COMMENT_LIMITS.maxBodyBytes
    ? Effect.fail(failure("too_long"))
    : Effect.void;

const authorOf = (request: CommentRequest) =>
  request.operation === "agentReplyComment"
    ? encodeAuthor({ kind: "agent", threadId: request.input.agentThreadId })
    : USER_AUTHOR;

export const execute = Effect.fn("SpacesComments.execute")(function* (
  request: CommentRequest,
  meta: Receipts.Metadata,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const now = DateTime.formatIso(DateTime.makeUnsafe(meta.observed_time_ms));
  const ack = { mutationId: request.input.mutationId, receiptEpoch: request.input.receiptEpoch };
  const finish = Effect.fnUntraced(function* (
    pageId: string,
    spaceId: string,
    threadId: string,
    extra: { readonly commentId?: string; readonly threadDeleted?: true } = {},
  ) {
    const commentRevision = yield* touchPage(pageId, spaceId);
    return decodeReceipt({
      operation: request.operation,
      result: {
        status: "saved",
        ...ack,
        pageId,
        commentRevision,
        commentThreadId: threadId,
        ...extra,
      },
    });
  });
  switch (request.operation) {
    case "createCommentThread": {
      const input = request.input;
      yield* checkBody(input.body);
      const page = yield* livePage(input.pageId);
      const [block] = yield* sql`SELECT 1 FROM spaces_blocks
        WHERE block_id = ${input.blockId} AND page_id = ${input.pageId} AND deleted = 0`;
      if (!block) return yield* new C.SpaceNotFoundError({ entity: "block", id: input.blockId });
      const [count] = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM spaces_comment_threads WHERE page_id = ${input.pageId}`;
      if ((count?.n ?? 0) >= C.SPACE_COMMENT_LIMITS.maxThreadsPerPage)
        return yield* failure("page_full");
      const threadId = NodeCrypto.randomUUID();
      const commentId = NodeCrypto.randomUUID();
      yield* sql`INSERT INTO spaces_comment_threads
        (thread_id, page_id, block_id, anchor, created_at, next_ordinal)
        VALUES (${threadId}, ${input.pageId}, ${input.blockId}, ${encodeAnchor(input.anchor)}, ${now}, 1)`;
      yield* sql`INSERT INTO spaces_comments (comment_id, thread_id, ordinal, author, body, created_at)
        VALUES (${commentId}, ${threadId}, 0, ${USER_AUTHOR}, ${encodeBody(input.body)}, ${now})`;
      return yield* finish(input.pageId, page.space_id, threadId, { commentId });
    }
    case "replyComment":
    case "agentReplyComment": {
      const input = request.input;
      yield* checkBody(input.body);
      const thread = yield* loadThread(input.commentThreadId);
      const page = yield* livePage(thread.page_id);
      if (thread.resolved_at !== null) return yield* failure("resolved", thread.thread_id);
      const [count] = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM spaces_comments WHERE thread_id = ${thread.thread_id}`;
      if ((count?.n ?? 0) >= C.SPACE_COMMENT_LIMITS.maxCommentsPerThread)
        return yield* failure("thread_full", thread.thread_id);
      const commentId = NodeCrypto.randomUUID();
      yield* sql`INSERT INTO spaces_comments (comment_id, thread_id, ordinal, author, body, created_at)
        VALUES (${commentId}, ${thread.thread_id}, ${thread.next_ordinal}, ${authorOf(request)},
          ${encodeBody(input.body)}, ${now})`;
      yield* sql`UPDATE spaces_comment_threads SET next_ordinal = next_ordinal + 1
        WHERE thread_id = ${thread.thread_id}`;
      yield* bumpThread(thread.thread_id);
      return yield* finish(thread.page_id, page.space_id, thread.thread_id, { commentId });
    }
    case "editComment": {
      const input = request.input;
      yield* checkBody(input.body);
      const { comment, thread } = yield* loadComment(input.commentId);
      const page = yield* livePage(thread.page_id);
      if (comment.author !== USER_AUTHOR) return yield* failure("not_author", comment.comment_id);
      yield* sql`UPDATE spaces_comments SET body = ${encodeBody(input.body)}, edited_at = ${now}
        WHERE comment_id = ${comment.comment_id}`;
      yield* bumpThread(thread.thread_id);
      return yield* finish(thread.page_id, page.space_id, thread.thread_id, {
        commentId: comment.comment_id,
      });
    }
    case "deleteComment": {
      const { comment, thread } = yield* loadComment(request.input.commentId);
      const page = yield* livePage(thread.page_id);
      if (comment.author !== USER_AUTHOR) return yield* failure("not_author", comment.comment_id);
      if (comment.ordinal === 0) {
        yield* sql`DELETE FROM spaces_comment_threads WHERE thread_id = ${thread.thread_id}`;
        return yield* finish(thread.page_id, page.space_id, thread.thread_id, {
          threadDeleted: true,
        });
      }
      yield* sql`DELETE FROM spaces_comments WHERE comment_id = ${comment.comment_id}`;
      yield* bumpThread(thread.thread_id);
      return yield* finish(thread.page_id, page.space_id, thread.thread_id);
    }
    case "resolveCommentThread":
    case "reopenCommentThread": {
      const thread = yield* loadThread(request.input.commentThreadId);
      const page = yield* livePage(thread.page_id);
      if (request.operation === "resolveCommentThread")
        yield* sql`UPDATE spaces_comment_threads
          SET resolved_at = COALESCE(resolved_at, ${now}), resolved_by = ${USER_AUTHOR},
            revision = revision + 1 WHERE thread_id = ${thread.thread_id}`;
      else
        yield* sql`UPDATE spaces_comment_threads
          SET resolved_at = NULL, resolved_by = NULL, revision = revision + 1
          WHERE thread_id = ${thread.thread_id}`;
      return yield* finish(thread.page_id, page.space_id, thread.thread_id);
    }
  }
});
