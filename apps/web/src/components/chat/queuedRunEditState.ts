import type {
  ChatAttachment,
  MessageId,
  OrchestrationMessageContext,
  RunId,
  ThreadId,
} from "@t2code/contracts";
import { makeQueuedRunEditStore } from "@t2code/client-runtime/queued-run-edit";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";

export interface EditingQueuedRun {
  readonly id: string;
  readonly originalAttachments: ReadonlyArray<ChatAttachment>;
  readonly saveOutcome: "not-sent" | "uncertain" | "accepted";
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}

// Keyed by the route thread, so an edit survives navigating away and back.
export const queuedRunEdits = makeQueuedRunEditStore<EditingQueuedRun>({
  registry: appAtomRegistry,
  label: "web-queued-run-edits",
});

export function queuedEditDraftKey(threadKey: string, runId: RunId) {
  return `queued-edit:${threadKey}:${runId}`;
}

export function isQueuedEditDraftOwned(target: ComposerThreadTarget) {
  return (
    typeof target === "string" &&
    Object.entries(appAtomRegistry.get(queuedRunEdits.atom)).some(
      ([key, edit]) => queuedEditDraftKey(key, edit.runId) === target,
    )
  );
}
