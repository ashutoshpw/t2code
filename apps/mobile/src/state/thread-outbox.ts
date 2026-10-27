import { prepareMobileComposerContext } from "./prepare-mobile-composer-context";
import type { ComposerContextDraft } from "@t2code/contracts";
import { appAtomRegistry } from "./atom-registry";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { expoThreadOutboxStorage, flushThreadOutboxWrites } from "./thread-outbox-storage";

export * from "./thread-outbox-model";

export const threadOutboxManager = createThreadOutboxManager({
  registry: appAtomRegistry,
  storage: expoThreadOutboxStorage,
});

/** Drain queued mutations too; optimistic publication precedes the durable file write. */
export async function flushThreadOutbox(): Promise<void> {
  await threadOutboxManager.serialize(async () => {});
  await flushThreadOutboxWrites();
}

export async function enqueueThreadOutboxMessage(
  message: QueuedThreadMessage,
  preparation?: {
    contextDraft?: ComposerContextDraft | undefined;
    isCurrentDraft?: (() => boolean) | undefined;
  },
): Promise<void> {
  const context = await prepareMobileComposerContext({ ...message, ...preparation });
  await threadOutboxManager.enqueue(
    context === message.context
      ? message
      : { ...message, ...(context ? { context } : { context: undefined }) },
  );
}

export function confirmThreadOutboxMessageQueued(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.confirmQueued(message);
}

/** Returns false if removed or if expectedRevision differs from threadOutboxRevision; otherwise rewrites the message. */
export function updateThreadOutboxMessage(
  message: QueuedThreadMessage,
  expectedRevision?: number,
): Promise<boolean> {
  return threadOutboxManager.update(message, expectedRevision);
}

export function threadOutboxRevision(messageId: QueuedThreadMessage["messageId"]): number {
  return threadOutboxManager.revisionOf(messageId);
}

// Removal needs draft-state ownership to release files; keep that dependency outside this module.
