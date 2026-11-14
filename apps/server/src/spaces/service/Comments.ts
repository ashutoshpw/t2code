import type { EnvironmentId, ProjectId, RunId, ThreadId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Dispatches from "../comments/Dispatches.ts";
import * as Store from "../comments/Store.ts";
import { touchPage } from "../comments/Writes.ts";
import { checkIds, isServiceError, strict, validateRaw } from "./Helpers.ts";
import * as PageStore from "../PageStore.ts";
import type { Runtime } from "./Runtime.ts";

const decodeList = Schema.decodeUnknownEffect(C.SpaceCommentsListInput, strict);

export interface RecordDispatchInput {
  readonly environmentId: EnvironmentId;
  readonly commentId: C.SpaceCommentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly runId: RunId;
  readonly mode: C.SpaceCommentDispatchMode;
  readonly status: C.SpaceCommentDispatchStatus;
}

export const make = (rt: Runtime) => {
  const { admit, checkEnvironment, read, readWithAdmission, run } = rt;

  const listComments = Effect.fn("SpacesService.listComments")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeList),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* readWithAdmission(environmentId, (_meta, admission) =>
      Effect.gen(function* () {
        yield* checkIds(input);
        if ("commentThreadId" in input) {
          const thread = yield* Store.listThread(input.commentThreadId);
          return {
            pageId: thread.pageId,
            commentRevision: yield* Store.pageCommentRevision(thread.pageId),
            threads: [thread],
            nextCursor: null,
            mutationAdmission: admission,
          };
        }
        const page = yield* Store.listPage({
          environmentId,
          pageId: input.pageId,
          status: input.status,
          cursor: input.cursor,
        });
        return { pageId: input.pageId, ...page, mutationAdmission: admission };
      }),
    );
  });

  const prepareCommentDispatch = Effect.fn("SpacesService.prepareCommentDispatch")(
    function* (input: {
      readonly environmentId: EnvironmentId;
      readonly commentId: C.SpaceCommentId;
    }) {
      const environmentId = yield* admit();
      yield* checkEnvironment(environmentId, input.environmentId);
      return yield* read(environmentId, () =>
        Effect.gen(function* () {
          const found = yield* Store.loadComment(input.commentId);
          const thread = yield* Store.listThread(found.thread.thread_id);
          const comment = thread.comments.find((item) => item.id === input.commentId);
          if (comment === undefined)
            return yield* new C.SpaceCommentError({ reason: "not_found", id: input.commentId });
          if (comment.author.kind !== "user")
            return yield* new C.SpaceCommentError({ reason: "not_dispatchable", id: comment.id });
          if (thread.status === "resolved")
            return yield* new C.SpaceCommentError({ reason: "resolved", id: thread.id });
          const page = yield* PageStore.load(thread.pageId);
          return {
            comment,
            thread,
            page: { id: page.page_id, spaceId: page.space_id, title: page.title },
          };
        }),
      );
    },
  );

  const recordCommentDispatch = Effect.fn("SpacesService.recordCommentDispatch")(function* (
    input: RecordDispatchInput,
  ) {
    const environmentId = yield* admit();
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* run(environmentId, (meta) =>
      Effect.gen(function* () {
        const { thread } = yield* Store.loadComment(input.commentId);
        const page = yield* PageStore.load(C.SpacePageId.make(thread.page_id));
        const stored = yield* Dispatches.find(input.commentId);
        if (stored !== undefined) {
          if (stored.thread_id !== input.threadId || stored.message_id !== input.messageId)
            return yield* new C.SpaceCommentError({
              reason: "already_dispatched",
              id: input.commentId,
            });
          return {
            dispatch: Store.toDispatch(stored),
            commentRevision: yield* Store.pageCommentRevision(thread.page_id),
          };
        }
        const row = {
          comment_id: input.commentId,
          environment_id: input.environmentId,
          project_id: input.projectId,
          thread_id: input.threadId,
          message_id: input.messageId,
          run_id: input.runId,
          mode: input.mode,
          status: input.status,
          updated_at: DateTime.formatIso(DateTime.makeUnsafe(meta.observed_time_ms)),
        };
        yield* Dispatches.insert(row);
        return {
          dispatch: Store.toDispatch(row),
          commentRevision: yield* touchPage(thread.page_id, page.space_id),
        };
      }),
    );
  });

  const updateCommentDispatchRun = Effect.fn("SpacesService.updateCommentDispatchRun")(
    function* (input: { readonly runId: RunId; readonly status: C.SpaceCommentDispatchStatus }) {
      const environmentId = yield* admit();
      return yield* run(environmentId, (meta) =>
        Effect.gen(function* () {
          const changed = yield* Dispatches.updateByRun(
            input.runId,
            input.status,
            DateTime.formatIso(DateTime.makeUnsafe(meta.observed_time_ms)),
          );
          const pages = new Map(changed.map((row) => [row.page_id, row.space_id]));
          for (const [pageId, spaceId] of pages) yield* touchPage(pageId, spaceId);
          return changed.length > 0;
        }),
      );
    },
  );

  const listActiveCommentDispatches = Effect.fn("SpacesService.listActiveCommentDispatches")(
    function* () {
      const environmentId = yield* admit();
      return yield* read(environmentId, () =>
        Effect.map(Dispatches.active(), (rows) =>
          rows.map((row) => ({
            commentId: C.SpaceCommentId.make(row.comment_id),
            projectId: Store.toDispatch(row).projectId,
            threadId: Store.toDispatch(row).threadId,
            runId: Store.toDispatch(row).runId,
            status: row.status,
          })),
        ),
      );
    },
  );

  return {
    listComments,
    prepareCommentDispatch,
    recordCommentDispatch,
    updateCommentDispatchRun,
    listActiveCommentDispatches,
  };
};
