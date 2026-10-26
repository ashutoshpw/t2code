import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t2code/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t2code/client-runtime/state/runtime";
import { formatSendLaterLabel } from "@t2code/client-runtime/state/send-later";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { useStableCallback } from "../../hooks/useStableCallback";
import { resolveShortcutCommand } from "../../keybindings";
import type { ResolvedKeybindingsConfig } from "@t2code/contracts";
import { readEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { requestSendLater } from "./SendLaterDialog";
import { subscribeToSendLater } from "./sendLaterEvents";
import { sendLaterDisabledReason, sendLaterTitle } from "./sendLater.logic";

/**
 * Schedules the composer draft as a one-time task bound to this thread, so it
 * is delivered by the server (even if this client is closed) and shows up on
 * the Scheduled tasks page.
 */
export function useSendLater(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  projectId: ProjectId | null;
  prompt: string;
  hasNonTextContent: boolean;
  isEditingQueuedMessage: boolean;
  environmentAvailable: boolean;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  keybindings: ResolvedKeybindingsConfig;
  onScheduled: () => void;
}) {
  const router = useRouter();
  const canSchedule = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(input.environmentId),
  );
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "send later",
  });

  const disabledReason = sendLaterDisabledReason({
    isServerThread: input.threadId !== null && input.projectId !== null,
    environmentAvailable: input.environmentAvailable,
    canSchedule,
    isEditingQueuedMessage: input.isEditingQueuedMessage,
    hasNonTextContent: input.hasNonTextContent,
    prompt: input.prompt,
  });

  const schedule = useStableCallback(async () => {
    const { threadId, projectId } = input;
    const prompt = input.prompt.trim();
    if (
      disabledReason !== null ||
      threadId === null ||
      projectId === null ||
      !readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }
    const at = await requestSendLater();
    if (at === null) return;
    const result = await upsertTask({
      environmentId: input.environmentId,
      input: {
        title: sendLaterTitle(prompt),
        prompt,
        enabled: true,
        schedule: { type: "once", at },
        projectId,
        threadId,
        // Ignored for a thread-bound task; the thread keeps its own workspace.
        workspaceStrategy: { type: "root" },
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        creationSource: "web",
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        // The draft stays in the composer so nothing is lost on failure.
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not schedule message",
            description: String(squashAtomCommandFailure(result)),
          }),
        );
      }
      return;
    }
    input.onScheduled();
    const taskId = result.value.task.id;
    const toastId = toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `Message scheduled for ${formatSendLaterLabel(at, new Date())}`,
        description: "Change the time or cancel it from Scheduled tasks.",
        actionProps: {
          children: "View",
          onClick: () => {
            toastManager.close(toastId);
            void router.navigate({
              to: "/scheduled-tasks",
              search: { environmentId: input.environmentId, taskId },
            });
          },
        },
      }),
    );
  });

  // Shortcut and command palette entry points. A blocked attempt explains why
  // instead of doing nothing, since there is no disabled button to hover.
  const startFromEntryPoint = useStableCallback(() => {
    if (isCommandPaletteOpen()) return;
    if (disabledReason !== null) {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Cannot send later",
          description: disabledReason,
        }),
      );
      return;
    }
    void schedule();
  });
  // oxlint-disable-next-line t2code/react-effect-budget -- Register with the shared send-later store, which lives outside React and invokes this callback from the palette and the composer.
  useEffect(() => subscribeToSendLater(() => startFromEntryPoint()), [startFromEntryPoint]);
  const handleShortcut = useStableCallback((event: KeyboardEvent) => {
    if (resolveShortcutCommand(event, input.keybindings) !== "composer.sendLater") return;
    event.preventDefault();
    event.stopPropagation();
    startFromEntryPoint();
  });
  // oxlint-disable-next-line t2code/react-effect-budget -- The global keybinding listener is window state that must follow the active composer.
  useEffect(() => {
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [handleShortcut]);

  return { onSendLater: schedule, sendLaterDisabledReason: disabledReason };
}
