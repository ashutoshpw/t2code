import { getComposerPromptLengthValidationMessage } from "./composerSubmission";

export const SEND_LATER_TITLE_MAX_LENGTH = 80;

/**
 * Scheduled messages are text-only: the scheduler stores a prompt, not
 * attachments or inline contexts, so anything else would be silently dropped.
 */
export function sendLaterDisabledReason(input: {
  isServerThread: boolean;
  environmentAvailable: boolean;
  canSchedule: boolean;
  isEditingQueuedMessage: boolean;
  hasNonTextContent: boolean;
  prompt: string;
}): string | null {
  if (!input.isServerThread) return "Send the first message before scheduling follow-ups.";
  if (!input.environmentAvailable) return "Environment disconnected";
  if (!input.canSchedule) return "You cannot schedule messages in this environment.";
  if (input.isEditingQueuedMessage) return "Finish editing the queued message first.";
  if (input.hasNonTextContent) return "Text only. Remove attachments and context to schedule.";
  if (input.prompt.trim().length === 0) return "Write a message first.";
  return getComposerPromptLengthValidationMessage(input.prompt);
}

/** The task list needs a short title; the first line of the message is what users recognise. */
export function sendLaterTitle(prompt: string): string {
  const firstLine =
    prompt
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  if (firstLine.length === 0) return "Scheduled message";
  return firstLine.length > SEND_LATER_TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, SEND_LATER_TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : firstLine;
}
