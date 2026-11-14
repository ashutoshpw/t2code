import {
  CommandId,
  MessageId,
  type OrchestrationMessageContext,
  type OrchestrationV2Run,
  type ProjectId,
  ThreadId,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { dispatchStatusOf, isTerminalDispatchRun } from "./comments/dispatchStatus.ts";
import { commentDispatchMessage } from "./comments/dispatchMessage.ts";
import { resolveCommentLaunch } from "./comments/launchDefaults.ts";
import * as SpacesService from "./SpacesService.ts";

export class CommentDispatchService extends Context.Service<
  CommentDispatchService,
  {
    /** Sends a comment to a session; the same comment always uses the same command and message ids. */
    readonly dispatch: (
      input: C.SpaceCommentDispatchInput,
    ) => Effect.Effect<C.SpaceCommentDispatchResult, C.SpaceServiceError>;
    /** Follows dispatched runs; started once with the server. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t2code/cli/spaces/CommentDispatchService") {}

const failure = (reason: C.SpaceCommentError["reason"], id?: C.SpaceCommentId) =>
  new C.SpaceCommentError(id === undefined ? { reason } : { reason, id });

export const make = Effect.gen(function* () {
  const spaces = yield* SpacesService.SpacesService;
  const threadManagement = yield* ThreadManagement.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const launchContext = yield* Effect.context<
    | Project.ProjectService
    | ServerSettings.ServerSettingsService
    | ProviderRegistry.ProviderRegistry
  >();
  const tracked = new Set<OrchestrationV2Run["id"]>();

  const observeRun = Effect.fn("CommentDispatchService.observeRun")(function* (
    run: Pick<OrchestrationV2Run, "id" | "status">,
  ) {
    if (!tracked.has(run.id)) return;
    if (isTerminalDispatchRun(run.status)) tracked.delete(run.id);
    yield* spaces
      .updateCommentDispatchRun({ runId: run.id, status: dispatchStatusOf(run.status) })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("space comment dispatch status update failed", { cause }),
        ),
      );
  });

  const reconcile = Effect.fn("CommentDispatchService.reconcile")(function* (target: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) {
    const { runs } = yield* threadManagement.getProjectThreadRecords(target, ["runs"]);
    yield* Effect.forEach(runs, observeRun, { discard: true });
  });

  type Delivery = {
    readonly commandId: CommandId;
    readonly messageId: MessageId;
    readonly text: string;
    readonly context: OrchestrationMessageContext | undefined;
    readonly createdBy: "user";
    readonly creationSource: "web" | "mobile";
  };
  const reason = (error: { readonly _tag: string }) =>
    error._tag === "ThreadManagementThreadArchivedError"
      ? failure("thread_archived")
      : error._tag === "ThreadManagementThreadNotFoundError"
        ? failure("thread_not_found")
        : failure("dispatch_failed");

  const sendExisting = Effect.fn("CommentDispatchService.sendExisting")(function* (
    threadId: ThreadId,
    delivery: Delivery,
  ) {
    const shell = yield* threadManagement.getThreadShell(threadId).pipe(Effect.mapError(reason));
    if (shell === null || shell.deletedAt !== null) return yield* failure("thread_not_found");
    if (shell.archivedAt !== null) return yield* failure("thread_archived");
    const result = yield* threadManagement
      .sendToThread({
        projectId: shell.projectId,
        commandId: delivery.commandId,
        threadId,
        messageId: delivery.messageId,
        text: delivery.text,
        attachments: [],
        ...(delivery.context === undefined ? {} : { context: delivery.context }),
        mode: "queue",
        createdBy: delivery.createdBy,
        creationSource: delivery.creationSource,
      })
      .pipe(Effect.mapError(reason));
    return { projectId: shell.projectId, threadId, run: result.run };
  });

  const startNew = Effect.fn("CommentDispatchService.startNew")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    delivery: Delivery & { readonly title: string },
  ) {
    const defaults = yield* resolveCommentLaunch(projectId).pipe(
      Effect.provideContext(launchContext),
    );
    const launched = yield* threadLaunch
      .launch({
        commandId: delivery.commandId,
        threadId,
        projectId,
        title: delivery.title,
        ...defaults,
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: delivery.messageId,
          text: delivery.text,
          attachments: [],
          ...(delivery.context === undefined ? {} : { context: delivery.context }),
        },
        createdBy: delivery.createdBy,
        creationSource: delivery.creationSource,
      })
      .pipe(Effect.mapError(reason));
    const run = launched.projection.runs.find(
      (candidate) => candidate.userMessageId === delivery.messageId,
    );
    if (run === undefined) return yield* failure("dispatch_failed");
    return { projectId, threadId, run };
  });

  const dispatch = Effect.fn("CommentDispatchService.dispatch")(function* (
    input: C.SpaceCommentDispatchInput,
  ) {
    const { commentId } = input;
    const { comment, thread, page } = yield* spaces.prepareCommentDispatch({
      environmentId: input.environmentId,
      commentId,
    });
    const commandId = CommandId.make(`space-comment:${commentId}`);
    const messageId = MessageId.make(`space-comment-message:${commentId}`);
    const newThreadId = ThreadId.make(`space-comment-thread:${commentId}`);
    const wanted = input.target.kind === "thread" ? input.target.threadId : newThreadId;

    if (comment.dispatch !== undefined) {
      if (comment.dispatch.threadId !== wanted)
        return yield* failure("already_dispatched", commentId);
      const stored = yield* spaces.recordCommentDispatch({
        environmentId: input.environmentId,
        commentId,
        projectId: comment.dispatch.projectId,
        threadId: comment.dispatch.threadId,
        messageId,
        runId: comment.dispatch.runId,
        mode: comment.dispatch.mode,
        status: comment.dispatch.status,
      });
      return { status: "dispatched" as const, ...stored };
    }

    const captured = yield* spaces
      .captureContextSnapshot({
        environmentId: input.environmentId,
        contextId: `comment-${commentId}`,
        target:
          thread.resolvedBlockId === undefined
            ? { kind: "page", pageId: thread.pageId }
            : { kind: "block", blockId: thread.resolvedBlockId },
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    const context: OrchestrationMessageContext | undefined =
      captured?.status === "captured" ? { version: 1, records: [captured.record] } : undefined;
    const text = commentDispatchMessage({
      mode: input.mode,
      pageTitle: page.title,
      environmentId: input.environmentId,
      pageId: page.id,
      blockId: thread.blockId,
      commentThreadId: thread.id,
      commentId,
      text: comment.body.map((run) => run.text).join(""),
      quote: thread.anchor.kind === "range" ? thread.anchor.quote : undefined,
    });
    const creation = { createdBy: "user", creationSource: input.creationSource } as const;
    const sent = yield* input.target.kind === "thread"
      ? sendExisting(input.target.threadId, { commandId, messageId, text, context, ...creation })
      : startNew(input.target.projectId, newThreadId, {
          commandId,
          messageId,
          text,
          context,
          title: `Comment on ${page.title || "Untitled page"}`,
          ...creation,
        });

    const recorded = yield* spaces.recordCommentDispatch({
      environmentId: input.environmentId,
      commentId,
      projectId: sent.projectId,
      threadId: sent.threadId,
      messageId,
      runId: sent.run.id,
      mode: input.mode,
      status: dispatchStatusOf(sent.run.status),
    });
    tracked.add(sent.run.id);
    yield* reconcile(sent).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("space comment dispatch reconcile failed", { cause }),
      ),
    );
    return { status: "dispatched" as const, ...recorded };
  });

  const start = Effect.fn("CommentDispatchService.start")(function* () {
    // Runs after activation so startup recovery's run.updated events are already published and reconcile reads their result.
    const followActive = Effect.gen(function* () {
      const active = yield* spaces
        .listActiveCommentDispatches()
        .pipe(Effect.orElseSucceed(() => []));
      for (const row of active) tracked.add(row.runId);
      const threads = new Map(active.map((row) => [row.threadId, row.projectId]));
      yield* Effect.forkScoped(
        Effect.forEach(
          threads,
          ([threadId, projectId]) =>
            reconcile({ projectId, threadId }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("space comment dispatch reconcile failed", { cause }),
              ),
            ),
          { discard: true },
        ),
      );
      yield* Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "run.created" || event.type === "run.updated"
          ? observeRun(event.payload)
          : Effect.void,
      );
    });
    yield* forkParked(
      followActive.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("space comment dispatch event stream failed", { cause }),
        ),
      ),
    );
  });

  return { dispatch, start, observeRun };
});

export const layer = Layer.effect(
  CommentDispatchService,
  make.pipe(Effect.map(({ dispatch, start }) => ({ dispatch, start }))),
);
