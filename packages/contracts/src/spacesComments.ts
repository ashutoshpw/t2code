import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
} from "./baseSchemas.ts";
import {
  SpaceBlockId,
  SpaceCursor,
  SpaceMutationAdmission,
  SpacePageId,
  SpaceRichText,
  StableId,
  mutationAck,
  mutationInput,
} from "./spacesCore.ts";

export const SPACE_COMMENT_LIMITS = {
  maxBodyBytes: 8192,
  maxBodyRuns: 64,
  maxQuoteChars: 1024,
  maxContextChars: 32,
  maxCommentsPerThread: 100,
  maxThreadsPerPage: 500,
  listThreads: 50,
  maxListResponseBytes: 1_048_576,
  maxAgentReplyChars: 4000,
} as const;

export const SpaceCommentThreadId = StableId.pipe(Schema.brand("SpaceCommentThreadId"));
export type SpaceCommentThreadId = typeof SpaceCommentThreadId.Type;
export const SpaceCommentId = StableId.pipe(Schema.brand("SpaceCommentId"));
export type SpaceCommentId = typeof SpaceCommentId.Type;

export const SpaceCommentAnchor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("block") }),
  Schema.Struct({
    kind: Schema.Literal("range"),
    quote: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(SPACE_COMMENT_LIMITS.maxQuoteChars),
    ),
    prefix: Schema.String.check(Schema.isMaxLength(SPACE_COMMENT_LIMITS.maxContextChars)),
    suffix: Schema.String.check(Schema.isMaxLength(SPACE_COMMENT_LIMITS.maxContextChars)),
    start: NonNegativeInt,
    end: PositiveInt,
  }).check(Schema.makeFilter((anchor) => anchor.end - anchor.start === anchor.quote.length)),
]);
export type SpaceCommentAnchor = typeof SpaceCommentAnchor.Type;
export const SpaceCommentAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("agent"), threadId: ThreadId }),
]);
export type SpaceCommentAuthor = typeof SpaceCommentAuthor.Type;
export const SpaceCommentBody = SpaceRichText.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(SPACE_COMMENT_LIMITS.maxBodyRuns),
);
export type SpaceCommentBody = typeof SpaceCommentBody.Type;

export const SpaceCommentDispatchMode = Schema.Literals(["edit", "message"]);
export type SpaceCommentDispatchMode = typeof SpaceCommentDispatchMode.Type;
export const SpaceCommentDispatchStatus = Schema.Literals([
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
]);
export type SpaceCommentDispatchStatus = typeof SpaceCommentDispatchStatus.Type;
export const SpaceCommentDispatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  runId: RunId,
  mode: SpaceCommentDispatchMode,
  status: SpaceCommentDispatchStatus,
  updatedAt: IsoDateTime,
});
export type SpaceCommentDispatch = typeof SpaceCommentDispatch.Type;
export const SpaceComment = Schema.Struct({
  id: SpaceCommentId,
  author: SpaceCommentAuthor,
  body: SpaceRichText,
  createdAt: IsoDateTime,
  editedAt: Schema.NullOr(IsoDateTime),
  dispatch: Schema.optionalKey(SpaceCommentDispatch),
});
export type SpaceComment = typeof SpaceComment.Type;
export const SpaceCommentAnchorState = Schema.Literals(["live", "merged", "detached"]);
export type SpaceCommentAnchorState = typeof SpaceCommentAnchorState.Type;
export const SpaceCommentThread = Schema.Struct({
  id: SpaceCommentThreadId,
  pageId: SpacePageId,
  blockId: SpaceBlockId,
  /** Where the block lives now: itself, or what it merged into. Absent when detached. */
  resolvedBlockId: Schema.optionalKey(SpaceBlockId),
  anchorState: SpaceCommentAnchorState,
  anchor: SpaceCommentAnchor,
  status: Schema.Literals(["open", "resolved"]),
  resolvedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  revision: PositiveInt,
  comments: Schema.Array(SpaceComment),
});
export type SpaceCommentThread = typeof SpaceCommentThread.Type;

export const SpaceCommentsListInput = Schema.Union([
  Schema.Struct({
    environmentId: EnvironmentId,
    pageId: SpacePageId,
    status: Schema.Literals(["open", "resolved"]),
    cursor: Schema.optionalKey(SpaceCursor),
  }),
  Schema.Struct({ environmentId: EnvironmentId, commentThreadId: SpaceCommentThreadId }),
]);
export type SpaceCommentsListInput = typeof SpaceCommentsListInput.Type;
export const SpaceCommentsListResult = Schema.Struct({
  pageId: SpacePageId,
  commentRevision: NonNegativeInt,
  threads: Schema.Array(SpaceCommentThread),
  nextCursor: Schema.NullOr(SpaceCursor),
  mutationAdmission: SpaceMutationAdmission,
});
export type SpaceCommentsListResult = typeof SpaceCommentsListResult.Type;

export const SpaceCommentThreadCreateInput = Schema.Struct({
  ...mutationInput,
  pageId: SpacePageId,
  blockId: SpaceBlockId,
  anchor: SpaceCommentAnchor,
  body: SpaceCommentBody,
});
export type SpaceCommentThreadCreateInput = typeof SpaceCommentThreadCreateInput.Type;
export const SpaceCommentReplyInput = Schema.Struct({
  ...mutationInput,
  commentThreadId: SpaceCommentThreadId,
  body: SpaceCommentBody,
});
export type SpaceCommentReplyInput = typeof SpaceCommentReplyInput.Type;
/** Server-only: built by the MCP tool from the calling thread, never accepted over the wire. */
export const SpaceCommentAgentReplyInput = Schema.Struct({
  ...SpaceCommentReplyInput.fields,
  agentThreadId: ThreadId,
});
export type SpaceCommentAgentReplyInput = typeof SpaceCommentAgentReplyInput.Type;
export const SpaceCommentEditInput = Schema.Struct({
  ...mutationInput,
  commentId: SpaceCommentId,
  body: SpaceCommentBody,
});
export type SpaceCommentEditInput = typeof SpaceCommentEditInput.Type;
export const SpaceCommentDeleteInput = Schema.Struct({
  ...mutationInput,
  commentId: SpaceCommentId,
});
export type SpaceCommentDeleteInput = typeof SpaceCommentDeleteInput.Type;
export const SpaceCommentThreadStatusInput = Schema.Struct({
  ...mutationInput,
  commentThreadId: SpaceCommentThreadId,
});
export type SpaceCommentThreadStatusInput = typeof SpaceCommentThreadStatusInput.Type;
export const SpaceCommentMutationResult = Schema.Struct({
  status: Schema.Literal("saved"),
  ...mutationAck,
  pageId: SpacePageId,
  commentRevision: NonNegativeInt,
  commentThreadId: SpaceCommentThreadId,
  /** The comment written by create, reply, agent reply or edit. */
  commentId: Schema.optionalKey(SpaceCommentId),
  /** Deleting a thread's first comment deletes the thread. */
  threadDeleted: Schema.optionalKey(Schema.Literal(true)),
});
export type SpaceCommentMutationResult = typeof SpaceCommentMutationResult.Type;

export const SpaceCommentDispatchInput = Schema.Struct({
  environmentId: EnvironmentId,
  commentId: SpaceCommentId,
  mode: SpaceCommentDispatchMode,
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
    Schema.Struct({ kind: Schema.Literal("new"), projectId: ProjectId }),
  ]),
  creationSource: Schema.Literals(["web", "mobile"]),
});
export type SpaceCommentDispatchInput = typeof SpaceCommentDispatchInput.Type;
export const SpaceCommentDispatchResult = Schema.Struct({
  status: Schema.Literal("dispatched"),
  commentRevision: NonNegativeInt,
  dispatch: SpaceCommentDispatch,
});
export type SpaceCommentDispatchResult = typeof SpaceCommentDispatchResult.Type;
