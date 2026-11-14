import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2Run,
  type OrchestrationMessageContext,
  ProjectId,
  type ProviderInstanceId,
  RunId,
  ThreadId,
  MessageId,
  CommandId,
  type Project,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Project_ from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as CommentDispatch from "./CommentDispatchService.ts";
import { block, boot, env, fixture } from "./service/Spaces.testkit.ts";

const projectId = ProjectId.make("project:comments");
const existingId = ThreadId.make("existing-thread");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const runFor = (id: string, status: OrchestrationV2Run["status"], messageId: string) =>
  ({
    id: RunId.make(id),
    threadId: existingId,
    ordinal: 1,
    providerInstanceId: "codex" as ProviderInstanceId,
    modelSelection: { instanceId: "codex" as ProviderInstanceId, model: "gpt-5" },
    providerThreadId: null,
    userMessageId: MessageId.make(messageId),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  }) satisfies OrchestrationV2Run;
const project = {
  id: projectId,
  title: "Comments",
  workspaceRoot: "/tmp/comments",
  defaultModelSelection: {
    instanceId: "codex" as ProviderInstanceId,
    model: "gpt-5",
  },
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
} satisfies Project;

const reasonOf = (error: C.SpaceServiceError) =>
  error._tag === "SpaceCommentError" ? error.reason : error._tag;

interface Sent {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly threadId: ThreadId;
  readonly context: OrchestrationMessageContext | undefined;
  readonly createdBy: string;
  readonly creationSource: string;
}

const harness = Effect.fn("CommentDispatchTest.harness")(function* (
  options: { readonly archived?: boolean } = {},
) {
  const sends = yield* Ref.make<ReadonlyArray<Sent>>([]);
  const launches = yield* Ref.make<ReadonlyArray<Sent>>([]);
  const shell = {
    ...liveThreadShell(existingId, { activeRunId: null }),
    projectId,
    archivedAt: options.archived ? now : null,
  };
  const layer = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(shell),
      sendToThread: (input) =>
        Ref.update(sends, (all) => [
          ...all,
          {
            commandId: input.commandId,
            messageId: input.messageId,
            threadId: input.threadId,
            context: input.context,
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          },
        ]).pipe(
          Effect.map(() => {
            const run = runFor("run-sent", "queued", input.messageId);
            return {
              run,
              dispatch: { sequence: 1, storedEvents: [] },
              projection: { ...idleThreadProjection(shell), runs: [run] },
              message: {
                id: input.messageId,
                threadId: input.threadId,
                runId: run.id,
                nodeId: null,
                role: "user" as const,
                text: input.text,
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
                createdBy: input.createdBy,
                creationSource: input.creationSource,
              },
              turnItem: null,
              delivery: "queued" as const,
            };
          }),
        ),
      getProjectThreadRecords: () =>
        Effect.succeed({
          ...idleThreadProjection(shell),
          runs: [runFor("run-sent", "queued", "m")],
        }),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Ref.update(launches, (all) => [
          ...all,
          {
            commandId: input.commandId,
            messageId: input.initialMessage?.messageId ?? MessageId.make("none"),
            threadId: input.threadId ?? existingId,
            context: input.initialMessage?.context,
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          },
        ]).pipe(
          Effect.map(() => ({
            threadId: input.threadId ?? existingId,
            resumed: false,
            projection: {
              ...idleThreadProjection(shell),
              runs: [runFor("run-new", "preparing", input.initialMessage?.messageId ?? "none")],
            },
          })),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
    Layer.mock(Project_.ProjectService)({ getById: () => Effect.succeedSome(project) }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  );
  const service = yield* CommentDispatch.make.pipe(Effect.provide(layer));
  return { service, sends, launches };
});

const seedComment = Effect.fn("CommentDispatchTest.seed")(function* () {
  const booted = yield* boot();
  yield* booted.service.applyBlockBatch(
    booted.request("seed", 0, [{ kind: "insert", block: block("para") }]),
  );
  const created = yield* booted.service.createCommentThread({
    ...booted.common,
    mutationId: C.SpaceMutationId.make("thread"),
    pageId: booted.page.id,
    blockId: C.SpaceBlockId.make("para"),
    anchor: { kind: "block" },
    body: [{ text: "fix it", marks: [] }],
  });
  const commentId = created.commentId!;
  const dispatch = (
    target: C.SpaceCommentDispatchInput["target"],
    mode: C.SpaceCommentDispatchInput["mode"] = "edit",
  ) => ({ ...env, commentId, mode, target, creationSource: "web" as const });
  const stored = () =>
    booted.service.listComments({ ...env, pageId: booted.page.id, status: "open" });
  return { commentId, dispatch, stored };
});

it.layer(NodeServices.layer)("CommentDispatchService", (it) => {
  it.effect("sends to an existing thread with the same ids every attempt", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, sends } = yield* harness();
        const { commentId, dispatch, stored } = yield* seedComment();
        const input = dispatch({ kind: "thread", threadId: existingId });
        const first = yield* service.dispatch(input);
        const second = yield* service.dispatch(input);
        assert.deepEqual(second.dispatch, first.dispatch);
        const calls = yield* Ref.get(sends);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.commandId, `space-comment:${commentId}`);
        assert.equal(calls[0]?.messageId, `space-comment-message:${commentId}`);
        assert.equal(calls[0]?.createdBy, "user");
        assert.equal(calls[0]?.creationSource, "web");
        assert.equal(calls[0]?.context?.records.length, 1);
        const listed = yield* stored();
        assert.equal(listed.threads[0]?.comments[0]?.dispatch?.status, "queued");
      }),
    ),
  );

  it.effect("refuses archived threads and a second target", () =>
    fixture(() =>
      Effect.gen(function* () {
        const archived = yield* harness({ archived: true });
        const { dispatch, stored } = yield* seedComment();
        const refused = yield* archived.service
          .dispatch(dispatch({ kind: "thread", threadId: existingId }))
          .pipe(Effect.flip);
        assert.equal(reasonOf(refused), "thread_archived");
        assert.equal((yield* stored()).threads[0]?.comments[0]?.dispatch, undefined);
        const { service } = yield* harness();
        yield* service.dispatch(dispatch({ kind: "thread", threadId: existingId }));
        const other = yield* service
          .dispatch(dispatch({ kind: "thread", threadId: ThreadId.make("other") }))
          .pipe(Effect.flip);
        assert.equal(reasonOf(other), "already_dispatched");
      }),
    ),
  );

  it.effect("starts a new session with a thread id derived from the comment", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, launches } = yield* harness();
        const { commentId, dispatch, stored } = yield* seedComment();
        const result = yield* service.dispatch(dispatch({ kind: "new", projectId }, "message"));
        const calls = yield* Ref.get(launches);
        assert.equal(calls[0]?.threadId, `space-comment-thread:${commentId}`);
        assert.equal(calls[0]?.messageId, `space-comment-message:${commentId}`);
        assert.equal(result.dispatch.runId, "run-new");
        assert.equal(result.dispatch.threadId, `space-comment-thread:${commentId}`);
        assert.equal((yield* stored()).threads[0]?.comments[0]?.dispatch?.mode, "message");
      }),
    ),
  );

  it.effect("follows run status and ignores runs it does not track", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service } = yield* harness();
        const { dispatch, stored } = yield* seedComment();
        yield* service.dispatch(dispatch({ kind: "thread", threadId: existingId }));
        const revision = () => stored().pipe(Effect.map((listed) => listed.commentRevision));
        const status = () =>
          stored().pipe(Effect.map((listed) => listed.threads[0]?.comments[0]?.dispatch?.status));
        const base = yield* revision();
        yield* service.observeRun(runFor("untracked", "running", "x"));
        assert.equal(yield* revision(), base);
        yield* service.observeRun(runFor("run-sent", "running", "m"));
        assert.equal(yield* status(), "running");
        const running = yield* revision();
        assert.isAbove(running, base);
        yield* service.observeRun(runFor("run-sent", "completed", "m"));
        assert.equal(yield* status(), "done");
        const done = yield* revision();
        assert.isAbove(done, running);
        yield* service.observeRun(runFor("run-sent", "running", "m"));
        assert.equal(yield* status(), "done");
        assert.equal(yield* revision(), done);
      }),
    ),
  );
});
