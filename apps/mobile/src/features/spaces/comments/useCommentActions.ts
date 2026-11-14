import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t2code/contracts";
import {
  SpaceMutationId,
  type SpaceCommentDispatchInput,
  type SpaceCommentId,
  type SpaceCommentThreadId,
  type SpaceMutationAdmission,
  type SpacePageId,
  type SpaceRichText,
} from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";

import { uuidv4 } from "../../../lib/uuid";
import { appAtomRegistry } from "../../../state/atom-registry";
import { spacesEnvironment, useSpacesReadAccess } from "../../../state/spaces";

const comments = spacesEnvironment.comments;

type Settled<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> };

function unwrap<A>(result: Settled<A>): A {
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

export const commentErrorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The comment could not be saved.";

export interface CommentActions {
  readonly canWrite: boolean;
  readonly reply: (
    thread: SpaceCommentThreadId,
    body: SpaceRichText,
  ) => Promise<{ readonly commentId?: SpaceCommentId }>;
  readonly edit: (comment: SpaceCommentId, body: SpaceRichText) => Promise<void>;
  readonly remove: (comment: SpaceCommentId) => Promise<void>;
  readonly setResolved: (thread: SpaceCommentThreadId, resolved: boolean) => Promise<void>;
  readonly dispatch: (
    input: Omit<SpaceCommentDispatchInput, "environmentId" | "creationSource">,
  ) => Promise<void>;
}

/** Comment writes for one page; each carries the receipt epoch of the last list answer. */
export function useCommentActions(
  environmentId: EnvironmentId,
  pageId: SpacePageId,
  admission: SpaceMutationAdmission | undefined,
): CommentActions {
  const access = useSpacesReadAccess(environmentId);
  const permitted = useAtomValue(comments.reply.permissionAtom(environmentId));
  const canWrite = access.availability === "writable" && permitted && admission !== undefined;
  const fields = () => {
    if (admission === undefined) throw new Error("Comments are still loading.");
    return {
      environmentId,
      mutationId: SpaceMutationId.make(uuidv4()),
      receiptEpoch: admission.epoch,
    };
  };
  return {
    canWrite,
    reply: async (commentThreadId, body) => {
      const result = unwrap(
        await comments.reply.run(appAtomRegistry, {
          environmentId,
          input: { ...fields(), commentThreadId, body },
        }),
      );
      return result.commentId === undefined ? {} : { commentId: result.commentId };
    },
    edit: async (commentId, body) => {
      unwrap(
        await comments.edit.run(appAtomRegistry, {
          environmentId,
          input: { ...fields(), commentId, body },
        }),
      );
    },
    remove: async (commentId) => {
      unwrap(
        await comments.remove.run(appAtomRegistry, {
          environmentId,
          input: { ...fields(), commentId },
        }),
      );
    },
    setResolved: async (commentThreadId, resolved) => {
      const command = resolved ? comments.resolve : comments.reopen;
      unwrap(
        await command.run(appAtomRegistry, {
          environmentId,
          input: { ...fields(), commentThreadId },
        }),
      );
    },
    dispatch: async (input) => {
      unwrap(
        await comments.dispatch.run(appAtomRegistry, {
          environmentId,
          input: { ...input, environmentId, creationSource: "mobile", pageId },
        }),
      );
    },
  };
}
