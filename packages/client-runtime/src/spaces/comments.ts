import { isListedThreadLineage, type EnvironmentId } from "@t2code/contracts";
import type {
  SpaceBlockId,
  SpaceCapability,
  SpaceCommentDispatchStatus,
  SpaceCommentThread,
  SpaceRichText,
} from "@t2code/contracts/spaces";

import {
  matchComposerThreadItems,
  type ComposerThreadCandidate,
  type ComposerThreadItem,
} from "../composerThreadItems.ts";

const RECENT_THREAD_CHOICES = 5;

export const commentsSupported = (capability: SpaceCapability | undefined) =>
  capability?.version === 2 && capability.features?.comments === true;

/** One run, no marks; trailing whitespace is dropped and blank text is an empty body. */
export function commentRunsFromText(text: string): SpaceRichText {
  const trimmed = text.trimEnd();
  return trimmed.length === 0 ? [] : [{ text: trimmed, marks: [] }];
}

export function commentText(body: SpaceRichText): string {
  return body.map((run) => run.text).join("");
}

/** Open threads by the block they sit on now; threads whose block is gone are listed apart. */
export function groupSpaceCommentThreads(threads: readonly SpaceCommentThread[]) {
  const byBlock = new Map<SpaceBlockId, SpaceCommentThread[]>();
  const detached: SpaceCommentThread[] = [];
  let openCount = 0;
  for (const thread of threads) {
    if (thread.status !== "open") continue;
    openCount++;
    if (thread.resolvedBlockId === undefined) {
      detached.push(thread);
      continue;
    }
    const held = byBlock.get(thread.resolvedBlockId);
    if (held === undefined) byBlock.set(thread.resolvedBlockId, [thread]);
    else held.push(thread);
  }
  return {
    byBlock: byBlock as ReadonlyMap<SpaceBlockId, readonly SpaceCommentThread[]>,
    detached,
    openCount,
  };
}

const DISPATCH_LABELS: Record<SpaceCommentDispatchStatus, string> = {
  queued: "Queued",
  running: "Working",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};
export const spaceCommentDispatchLabel = (status: SpaceCommentDispatchStatus) =>
  DISPATCH_LABELS[status];

/** Sessions a comment can be sent to; never another environment's. */
export function spaceCommentThreadChoices(input: {
  readonly shells: ReadonlyArray<ComposerThreadCandidate>;
  readonly environmentId: EnvironmentId;
  readonly query: string;
  readonly now: number;
}): ComposerThreadItem[] {
  if (input.query.trim().length > 0)
    return matchComposerThreadItems({
      shells: input.shells,
      environmentId: input.environmentId,
      linkedEnvironments: new Map(),
      excludeThreadId: null,
      query: input.query,
      now: input.now,
    });
  return [...input.shells]
    .filter(
      (shell) =>
        shell.environmentId === input.environmentId &&
        shell.archivedAt === null &&
        isListedThreadLineage(shell.lineage),
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, RECENT_THREAD_CHOICES)
    .map((shell) => ({
      id: `thread:${shell.environmentId}:${shell.id}`,
      type: "thread",
      thread: { environmentId: shell.environmentId, threadId: shell.id },
      label: shell.title,
      description: "Thread",
    }));
}

/**
 * Writes a comment, then optionally sends it to a session. A failed send keeps the comment; the
 * caller retries the send with the returned comment id, which the server treats as the same send.
 */
export async function submitSpaceComment<W extends { readonly commentId?: string }>(input: {
  readonly write: () => Promise<W>;
  readonly dispatch?: (result: W & { readonly commentId: string }) => Promise<unknown>;
}): Promise<{ readonly result: W; readonly dispatchError: unknown | null }> {
  const result = await input.write();
  if (input.dispatch === undefined || result.commentId === undefined)
    return { result, dispatchError: null };
  try {
    await input.dispatch({ ...result, commentId: result.commentId });
    return { result, dispatchError: null };
  } catch (error) {
    return { result, dispatchError: error };
  }
}
