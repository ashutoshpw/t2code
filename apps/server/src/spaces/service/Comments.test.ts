import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { raw } from "./Databases.testkit.ts";
import { block, boot, env, fixture, recoveryIntent } from "./Spaces.testkit.ts";

type Booted = Effect.Success<ReturnType<typeof boot>>;

const env_ = (commentId: C.SpaceCommentId) => ({ ...env, commentId });
// Threads created in the same millisecond list in id order, so tests compare them by block.
const byBlock = (threads: readonly C.SpaceCommentThread[]) =>
  [...threads].sort((a, b) => a.blockId.localeCompare(b.blockId));
const text = (value: string): C.SpaceCommentBody => [{ text: value, marks: [] }];
const blockAnchor = { kind: "block" } as const;
const reasonOf = (error: C.SpaceServiceError) =>
  error._tag === "SpaceCommentError" || error._tag === "SpaceValidationError"
    ? error.reason
    : error._tag;

const seed = Effect.fn("CommentsTest.seed")(function* (booted: Booted, ids: readonly string[]) {
  const first = yield* booted.service.applyBlockBatch(
    booted.request(
      "seed",
      0,
      ids.map((id, index) => ({ kind: "insert" as const, block: block(id, index + 1) })),
    ),
  );
  assert.equal(first.status, "saved");
});

const writer = (booted: Booted) => {
  let n = 0;
  const base = () => ({ ...booted.common, mutationId: C.SpaceMutationId.make(`c-${++n}`) });
  return {
    base,
    create: (blockId: string, anchor: C.SpaceCommentAnchor = blockAnchor, body = text("hi")) =>
      booted.service.createCommentThread({
        ...base(),
        pageId: booted.page.id,
        blockId: C.SpaceBlockId.make(blockId),
        anchor,
        body,
      }),
    reply: (threadId: C.SpaceCommentThreadId, body = text("re")) =>
      booted.service.replyComment({ ...base(), commentThreadId: threadId, body }),
  };
};

const listOpen = (booted: Booted, status: "open" | "resolved" = "open") =>
  booted.service.listComments({ ...env, pageId: booted.page.id, status });

it.layer(NodeServices.layer)("Spaces comments", (it) => {
  it.effect("creates block and range threads without moving the page revision", () =>
    fixture(() =>
      Effect.gen(function* () {
        const booted = yield* boot();
        yield* seed(booted, ["a", "b"]);
        const before = (yield* booted.service.getPage({ ...env, pageId: booted.page.id })).page;
        const w = writer(booted);
        yield* w.create("a");
        yield* w.create("b", {
          kind: "range",
          quote: "b",
          prefix: "",
          suffix: "",
          start: 0,
          end: 1,
        });
        const listed = yield* listOpen(booted);
        assert.equal(listed.commentRevision, 2);
        assert.deepEqual(
          byBlock(listed.threads).map((thread) => [
            thread.blockId,
            thread.anchor.kind,
            thread.anchorState,
          ]),
          [
            ["a", "block", "live"],
            ["b", "range", "live"],
          ],
        );
        assert.equal(listed.threads[0]!.comments[0]!.author.kind, "user");
        const after = (yield* booted.service.getPage({ ...env, pageId: booted.page.id })).page;
        assert.equal(after.revision, before.revision);
      }),
    ),
  );

  it.effect("replies, edits, deletes, resolves and reopens with author rules", () =>
    fixture(() =>
      Effect.gen(function* () {
        const booted = yield* boot();
        yield* seed(booted, ["a"]);
        const w = writer(booted);
        const created = yield* w.create("a");
        const threadId = created.commentThreadId;
        const reply = yield* w.reply(threadId);
        const again = yield* booted.service.replyComment({
          ...booted.common,
          mutationId: C.SpaceMutationId.make("c-2"),
          commentThreadId: threadId,
          body: text("re"),
        });
        assert.equal(again.commentId, reply.commentId);
        const agentInput = { ...w.base(), commentThreadId: threadId, body: text("agent") };
        const agentThread = ThreadId.make("agent-thread");
        const agent = yield* booted.service.agentReplyComment(agentInput, agentThread);
        const edited = yield* booted.service.editComment({
          ...w.base(),
          commentId: reply.commentId!,
          body: text("edited"),
        });
        assert.equal(edited.commentId, reply.commentId);
        assert.equal(
          reasonOf(
            yield* Effect.flip(
              booted.service.editComment({
                ...w.base(),
                commentId: agent.commentId!,
                body: text("x"),
              }),
            ),
          ),
          "not_author",
        );
        const [thread] = (yield* listOpen(booted)).threads;
        assert.deepEqual(
          thread!.comments.map((comment) => comment.author),
          [{ kind: "user" }, { kind: "user" }, { kind: "agent", threadId: agentThread }],
        );
        assert.equal(thread!.comments.length, 3);
        yield* booted.service.deleteComment({ ...w.base(), commentId: reply.commentId! });
        assert.equal((yield* listOpen(booted)).threads[0]!.comments.length, 2);
        yield* booted.service.resolveCommentThread({ ...w.base(), commentThreadId: threadId });
        assert.equal((yield* listOpen(booted)).threads.length, 0);
        assert.equal((yield* listOpen(booted, "resolved")).threads.length, 1);
        assert.equal(reasonOf(yield* Effect.flip(w.reply(threadId))), "resolved");
        yield* booted.service.reopenCommentThread({ ...w.base(), commentThreadId: threadId });
        assert.equal((yield* listOpen(booted)).threads.length, 1);
        const removed = yield* booted.service.deleteComment({
          ...w.base(),
          commentId: created.commentId!,
        });
        assert.equal(removed.threadDeleted, true);
        assert.equal((yield* listOpen(booted)).threads.length, 0);
      }),
    ),
  );

  it.effect("follows merged blocks and detaches threads whose block is gone", () =>
    fixture(() =>
      Effect.gen(function* () {
        const booted = yield* boot();
        yield* seed(booted, ["a", "b", "c"]);
        const w = writer(booted);
        yield* w.create("a");
        const gone = yield* w.create("c");
        yield* booted.service.applyBlockBatch(
          booted.request("retire", 1, [
            {
              kind: "delete",
              blockId: C.SpaceBlockId.make("a"),
              mergedInto: C.SpaceBlockId.make("b"),
            },
            { kind: "delete", blockId: C.SpaceBlockId.make("c") },
          ]),
        );
        const threads = byBlock((yield* listOpen(booted)).threads);
        assert.deepEqual(
          threads.map((thread) => [thread.blockId, thread.anchorState, thread.resolvedBlockId]),
          [
            ["a", "merged", "b"],
            ["c", "detached", undefined],
          ],
        );
        const resolved = yield* booted.service.resolveCommentThread({
          ...w.base(),
          commentThreadId: gone.commentThreadId,
        });
        assert.equal(resolved.commentThreadId, gone.commentThreadId);
      }),
    ),
  );

  it.effect("refuses writes on trashed pages and removes comments with a deleted page", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const booted = yield* boot();
        yield* seed(booted, ["a"]);
        const w = writer(booted);
        yield* w.create("a");
        const trash = yield* recoveryIntent(
          booted.service,
          booted.common,
          booted.page.id,
          "trash",
          "trash",
        );
        yield* booted.service.trashPage(trash);
        assert.equal(reasonOf(yield* Effect.flip(w.create("a"))), "trashed");
        const purge = yield* recoveryIntent(
          booted.service,
          booted.common,
          booted.page.id,
          "permanentlyDelete",
          "purge",
        );
        yield* booted.service.permanentlyDeletePage(purge);
        const counts = yield* raw(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ readonly n: number }>`SELECT
              (SELECT COUNT(*) FROM spaces_comment_threads) + (SELECT COUNT(*) FROM spaces_comments)
              + (SELECT COUNT(*) FROM spaces_comment_pages) AS n`;
          }),
        );
        assert.equal(counts[0]!.n, 0);
      }),
    ),
  );

  it.effect("bounds bodies and pages the thread list with stale-cursor detection", () =>
    fixture(() =>
      Effect.gen(function* () {
        const booted = yield* boot();
        yield* seed(booted, ["a"]);
        const w = writer(booted);
        const tooLong = text("x".repeat(C.SPACE_COMMENT_LIMITS.maxBodyBytes + 1));
        assert.equal(reasonOf(yield* Effect.flip(w.create("a", blockAnchor, tooLong))), "too_long");
        for (let i = 0; i <= C.SPACE_COMMENT_LIMITS.listThreads; i++) yield* w.create("a");
        const first = yield* listOpen(booted);
        assert.equal(first.threads.length, C.SPACE_COMMENT_LIMITS.listThreads);
        assert.isNotNull(first.nextCursor);
        const second = yield* booted.service.listComments({
          ...env,
          pageId: booted.page.id,
          status: "open",
          cursor: first.nextCursor!,
        });
        assert.equal(second.threads.length, 1);
        assert.isNull(second.nextCursor);
        yield* w.create("a");
        const stale = yield* Effect.flip(
          booted.service.listComments({
            ...env,
            pageId: booted.page.id,
            status: "open",
            cursor: first.nextCursor!,
          }),
        );
        assert.equal(stale._tag, "SpaceCursorStaleError");
      }),
    ),
  );

  it.effect("records dispatches idempotently and follows run status", () =>
    fixture(() =>
      Effect.gen(function* () {
        const booted = yield* boot();
        yield* seed(booted, ["a"]);
        const w = writer(booted);
        const created = yield* w.create("a");
        const agentReply = yield* booted.service.agentReplyComment(
          { ...w.base(), commentThreadId: created.commentThreadId, body: text("a") },
          ThreadId.make("agent"),
        );
        const input = {
          ...env,
          commentId: created.commentId!,
          projectId: ProjectId.make("project"),
          threadId: ThreadId.make("session-1"),
          messageId: "message-1",
          runId: RunId.make("run-1"),
          mode: "edit" as const,
          status: "queued" as const,
        };
        const prepared = yield* booted.service.prepareCommentDispatch(env_(created.commentId!));
        assert.equal(prepared.page.id, booted.page.id);
        const first = yield* booted.service.recordCommentDispatch(input);
        const replay = yield* booted.service.recordCommentDispatch(input);
        assert.deepEqual(replay, first);
        assert.equal(
          reasonOf(
            yield* Effect.flip(
              booted.service.recordCommentDispatch({ ...input, threadId: ThreadId.make("other") }),
            ),
          ),
          "already_dispatched",
        );
        assert.equal(
          reasonOf(
            yield* Effect.flip(booted.service.prepareCommentDispatch(env_(agentReply.commentId!))),
          ),
          "not_dispatchable",
        );
        assert.equal((yield* booted.service.listActiveCommentDispatches()).length, 1);
        const revision = (yield* listOpen(booted)).commentRevision;
        assert.isFalse(
          yield* booted.service.updateCommentDispatchRun({ runId: input.runId, status: "queued" }),
        );
        assert.isTrue(
          yield* booted.service.updateCommentDispatchRun({ runId: input.runId, status: "done" }),
        );
        assert.equal((yield* listOpen(booted)).commentRevision, revision + 1);
        assert.equal((yield* booted.service.listActiveCommentDispatches()).length, 0);
        const [thread] = (yield* listOpen(booted)).threads;
        assert.equal(thread!.comments[0]!.dispatch?.status, "done");
      }),
    ),
  );
});
