import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t2code/contracts";
import {
  SpaceMutationId,
  type SpaceBlockId,
  type SpaceCommentAnchor,
  type SpaceCommentDispatchInput,
  type SpaceCommentDispatchMode,
  type SpaceCommentId,
  type SpaceCommentMutationResult,
  type SpaceCommentThreadId,
  type SpacePageId,
  type SpaceRichText,
} from "@t2code/contracts/spaces";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t2code/client-runtime/state/runtime";

import { randomUUID } from "~/lib/utils";
import { spacesEnvironment } from "~/state/spaces";
import { useAtomCommand } from "~/state/use-atom-command";
import { useSpaceCommentList } from "./useSpaceCommentList";

export interface SpaceCommentSendChoice {
  readonly mode: SpaceCommentDispatchMode;
  readonly target: SpaceCommentDispatchInput["target"];
}

async function settled<A>(pending: Promise<AtomCommandResult<A, unknown>>): Promise<A> {
  const result = await pending;
  if (result._tag === "Success") return result.value;
  const failure = squashAtomCommandFailure(result);
  throw failure instanceof Error ? failure : new Error("Could not update comments.");
}

/** Comment writes for one page. Every call rejects with the failure, so callers can show it in place. */
export function useSpaceCommentActions(environmentId: EnvironmentId, pageId: SpacePageId) {
  const { epoch } = useSpaceCommentList(environmentId, pageId, "open");
  const comments = spacesEnvironment.comments;
  const writable = useAtomValue(comments.create.permissionAtom(environmentId));
  const options = { reportFailure: false } as const;
  const run = {
    create: useAtomCommand(comments.create, options),
    reply: useAtomCommand(comments.reply, options),
    edit: useAtomCommand(comments.edit, options),
    remove: useAtomCommand(comments.remove, options),
    resolve: useAtomCommand(comments.resolve, options),
    reopen: useAtomCommand(comments.reopen, options),
    dispatch: useAtomCommand(comments.dispatch, options),
  };
  const ack = () => {
    if (epoch === undefined) throw new Error("Comments are still loading. Try again in a moment.");
    return { environmentId, mutationId: SpaceMutationId.make(randomUUID()), receiptEpoch: epoch };
  };
  const thread = (commentThreadId: SpaceCommentThreadId) => ({
    environmentId,
    input: { ...ack(), commentThreadId },
  });
  return {
    writable,
    create: (blockId: SpaceBlockId, anchor: SpaceCommentAnchor, body: SpaceRichText) =>
      settled<SpaceCommentMutationResult>(
        run.create({ environmentId, input: { ...ack(), pageId, blockId, anchor, body } }),
      ),
    reply: (commentThreadId: SpaceCommentThreadId, body: SpaceRichText) =>
      settled<SpaceCommentMutationResult>(
        run.reply({ environmentId, input: { ...ack(), commentThreadId, body } }),
      ),
    edit: (commentId: SpaceCommentId, body: SpaceRichText) =>
      settled(run.edit({ environmentId, input: { ...ack(), commentId, body } })),
    remove: (commentId: SpaceCommentId) =>
      settled(run.remove({ environmentId, input: { ...ack(), commentId } })),
    resolve: (commentThreadId: SpaceCommentThreadId) =>
      settled(run.resolve(thread(commentThreadId))),
    reopen: (commentThreadId: SpaceCommentThreadId) => settled(run.reopen(thread(commentThreadId))),
    dispatch: (commentId: SpaceCommentId, choice: SpaceCommentSendChoice) =>
      settled(
        run.dispatch({
          environmentId,
          input: { environmentId, commentId, ...choice, creationSource: "web", pageId },
        }),
      ),
  };
}
