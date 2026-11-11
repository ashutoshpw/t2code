import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  type RuntimeMode,
  type ThreadId,
} from "@t2code/contracts";
import {
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "@t2code/client-runtime/errors";
import { deriveThreadTitleSeed } from "@t2code/client-runtime/operations";
import { squashAtomCommandFailure } from "@t2code/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t2code/client-runtime/state/shell";
import { scopeProjectRef } from "@t2code/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { newMessageId, newThreadId, randomUUID } from "~/lib/utils";
import {
  type ComposerThreadTarget,
  type DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";
import type { buildMessageContext } from "../../lib/composerContextRecords";
import {
  FanoutRecovery,
  assertFanoutRetry,
  fanoutSelectionKey,
  validateFanoutSelections,
} from "../../lib/composerFanout";
import {
  reserveComposerSendRecovery,
  assertFanoutRecoveryAdmission,
} from "../../lib/composerSendRecovery";
import { usePromptStashStore } from "../../promptStashStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentProjects } from "../../state/projects";
import { composerDraftSendGuard } from "../../lib/prepareComposerSendContext";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  boundAttachmentIds,
  type ComposerSendSnapshot,
  type makeThreadErrorSetter,
  withMessageContext,
} from "../ChatView.logic";
import {
  draftSendState,
  type MultipleModelTarget,
  type prepareTurnAttachments,
} from "./chatViewSend";
import type { useLocalDispatchState } from "./useLocalDispatchState";
import * as Schema from "effect/Schema";

const decodeFanoutRecovery = Schema.decodeSync(FanoutRecovery);

interface MultipleModelSendInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly draftId: DraftId | null;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly composerRef: ComposerHandleRef;
  readonly promptRef: { current: string };
  readonly runtimeMode: RuntimeMode;
  readonly startFromOrigin: boolean;
  readonly beginLocalDispatch: ReturnType<typeof useLocalDispatchState>["beginLocalDispatch"];
  readonly resetLocalDispatch: ReturnType<typeof useLocalDispatchState>["resetLocalDispatch"];
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

function useMultipleModelSendPorts(routeThreadKey: string) {
  const navigate = useNavigate();
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const { sendInFlight: sendInFlightRef } = draftSendState(routeThreadKey);

  return { navigate, startThreadTurn, sendInFlightRef };
}

export function useMultipleModelSend(input: MultipleModelSendInput) {
  const ports = useMultipleModelSendPorts(input.routeThreadKey);
  return createMultipleModelSend(input, ports);
}

function createMultipleModelSend(
  input: MultipleModelSendInput,
  ports: ReturnType<typeof useMultipleModelSendPorts>,
) {
  const {
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
    draftId,
    composerDraftTarget,
    composerRef,
    promptRef,
    runtimeMode,
    startFromOrigin,
    beginLocalDispatch,
    resetLocalDispatch,
    setThreadError,
  } = input;
  const { navigate, startThreadTurn, sendInFlightRef } = ports;

  return async (send: {
    readonly threadId: ThreadId;
    readonly project: Pick<EnvironmentProject, "id" | "environmentId" | "workspaceRoot">;
    readonly branch: string;
    readonly selections: ReadonlyArray<ModelSelection>;
    readonly targets: ReadonlyArray<MultipleModelTarget>;
    readonly sendSnapshot: ComposerSendSnapshot;
    readonly recoveryContents: Parameters<typeof reserveComposerSendRecovery>[0]["contents"];
    readonly createdAt: string;
    readonly attachmentsPromise: ReturnType<typeof prepareTurnAttachments>;
    readonly usesAttachmentUploads: boolean;
    readonly readFileBlockReason: () => string | null;
    readonly buildOutgoingMessageContext: (
      attachmentIds: ReadonlyArray<string>,
    ) => ReturnType<typeof buildMessageContext>;
    readonly assertContextCurrent: () => void;
    readonly isCurrentDraft: () => boolean;
    readonly isCurrentSend: () => boolean;
  }) => {
    const entryId = `fanout:${randomUUID()}`;
    const session = readPreparedConnection(environmentId);
    const workspaceStillCurrent = composerDraftSendGuard(composerDraftTarget);
    const initialDraftSession = draftId
      ? useComposerDraftStore.getState().getDraftSession(draftId)
      : null;
    const retryAtSend = useComposerDraftStore
      .getState()
      .getComposerDraft(composerDraftTarget)?.fanoutRetry;
    let reserved = false;
    let cleared = false;
    let released = false;
    let outcomeWriteFailed = false;
    let invoked = 0;
    const requests: Promise<void>[] = [];
    const assertReady = (beforeClear: boolean) => {
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
        throw new Error("This connection cannot change threads.");
      if (!session || readPreparedConnection(environmentId) !== session)
        throw new Error("The connection changed before fanout dispatch.");
      send.assertContextCurrent();
      const liveSession = draftId
        ? useComposerDraftStore.getState().getDraftSession(draftId)
        : null;
      const liveProject = appAtomRegistry.get(
        environmentProjects.projectAtom(scopeProjectRef(environmentId, send.project.id)),
      );
      if (
        !liveSession ||
        !liveProject ||
        liveSession !== initialDraftSession ||
        liveSession.threadId !== send.threadId ||
        liveSession.environmentId !== environmentId ||
        liveSession.projectId !== send.project.id ||
        liveSession.branch !== send.branch ||
        liveSession.startFromOrigin !== startFromOrigin ||
        liveProject.workspaceRoot !== send.project.workspaceRoot ||
        (beforeClear && !workspaceStillCurrent())
      )
        throw new Error(
          "The draft workspace changed before sending. Review the current workspace and send again.",
        );
      if (beforeClear)
        assertFanoutRecoveryAdmission({
          environmentId,
          target: composerDraftTarget,
          prompt: send.recoveryContents.prompt,
          retry: useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)
            ?.fanoutRetry,
          ownEntryId: entryId,
        });
      if (beforeClear) {
        const store = useComposerDraftStore.getState();
        assertFanoutRetry({
          retry: store.getComposerDraft(composerDraftTarget)?.fanoutRetry,
          selections: send.selections,
          projectId: liveSession?.projectId,
          branch: liveSession?.branch ?? null,
          runtimeMode: store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? runtimeMode,
          startFromOrigin: liveSession?.startFromOrigin ?? false,
        });
      }
      const fileBlock = send.readFileBlockReason();
      if (fileBlock) throw new Error(fileBlock);
      if (
        !send.isCurrentSend() ||
        (beforeClear &&
          (!send.isCurrentDraft() || currentRouteThreadKeyRef.current !== routeThreadKey))
      )
        throw new Error(
          "The draft changed before sending. Send again to include your latest draft.",
        );
    };
    const record = (id: string, outcome: "uncertain" | "accepted" | "failed" | "not-sent") => {
      const result = usePromptStashStore.getState().recordFanoutOutcome(entryId, id, outcome);
      if (!result.durable) outcomeWriteFailed = true;
      return result.durable;
    };
    const errorMessage = (error: unknown) =>
      (error instanceof Error ? error.message : "Could not send this model.").slice(0, 1000);
    try {
      validateFanoutSelections(send.selections);
      if (send.project.environmentId !== environmentId)
        throw new Error("The fanout project belongs to another environment.");
      if (
        send.targets.length !== send.selections.length ||
        send.targets.some(
          (target, index) =>
            fanoutSelectionKey(target.selection) !== fanoutSelectionKey(send.selections[index]!),
        )
      )
        throw new Error("The intended fanout targets changed. Select the models again.");
      const fanout: FanoutRecovery = {
        version: 1,
        routeKey: routeThreadKey,
        projectId: send.project.id,
        branch: send.branch,
        runtimeMode,
        startFromOrigin,
        attempts: send.selections.map((selection) => ({
          id: randomUUID(),
          selection: structuredClone(selection),
          threadId: newThreadId(),
          messageId: newMessageId(),
          outcome: "not-sent",
        })),
      };
      decodeFanoutRecovery(fanout);
      const attachments = await send.attachmentsPromise;
      assertReady(true);
      await reserveComposerSendRecovery({
        id: entryId,
        environmentId,
        threadId: send.threadId,
        draftId,
        target: composerDraftTarget,
        contents: send.recoveryContents,
        assertCurrent: () => assertReady(true),
        fanout,
      });
      reserved = true;
      assertReady(true);
      const context = send.buildOutgoingMessageContext(
        boundAttachmentIds(attachments, send.sendSnapshot.attachments),
      );
      const title = deriveThreadTitleSeed({
        text: send.sendSnapshot.messageText,
        attachments: send.sendSnapshot.attachments,
      });
      beginLocalDispatch({ preparingWorktree: true });
      promptRef.current = "";
      useComposerDraftStore.getState().clearComposerContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      cleared = true;
      setThreadError(send.threadId, null);
      for (const [index, attempt] of fanout.attempts.entries()) {
        let mayHaveInvoked = false;
        try {
          assertReady(false);
          if (!record(attempt.id, "uncertain"))
            throw new Error(
              "Could not persist fanout dispatch status. Remaining models were not sent.",
            );
          assertReady(false);
          const target = send.targets[index]!;
          mayHaveInvoked = true;
          invoked += 1;
          const result = startThreadTurn({
            environmentId,
            input: {
              threadId: attempt.threadId,
              message: {
                messageId: attempt.messageId,
                role: "user",
                attachments,
                ...withMessageContext({
                  text: target.text,
                  context,
                }),
              },
              modelSelection: attempt.selection,
              titleSeed: title,
              runtimeMode,
              interactionMode: target.interactionMode,
              bootstrap: {
                createThread: {
                  projectId: send.project.id,
                  title,
                  modelSelection: attempt.selection,
                  runtimeMode,
                  interactionMode: target.interactionMode,
                  branch: send.branch,
                  worktreePath: null,
                  createdAt: send.createdAt,
                },
                prepareWorktree: {
                  projectCwd: send.project.workspaceRoot,
                  baseBranch: send.branch,
                  requireWorktree: true,
                  ...(startFromOrigin ? { startFromOrigin: true } : {}),
                },
                runSetupScript: true,
              },
              createdAt: send.createdAt,
            },
          });
          requests.push(
            result.then(
              (reply) => {
                if (reply._tag === "Success") record(attempt.id, "accepted");
                else {
                  const error = squashAtomCommandFailure(reply);
                  const definite =
                    wasBootstrapThreadDeleted(error) || wasBootstrapThreadNotCreated(error);
                  if (definite) record(attempt.id, "failed");
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: definite
                        ? `Model send failed: ${attempt.selection.model}`
                        : `Outcome uncertain: ${attempt.selection.model}`,
                      description: errorMessage(error),
                    }),
                  );
                }
              },
              (error) => {
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: `Outcome uncertain: ${attempt.selection.model}`,
                    description: errorMessage(error),
                  }),
                );
              },
            ),
          );
        } catch (error) {
          if (!mayHaveInvoked) {
            const current = usePromptStashStore
              .getState()
              .entries.find((entry) => entry.id === entryId)
              ?.recovery?.fanout?.attempts.find((value) => value.id === attempt.id);
            if (current?.outcome === "uncertain") record(attempt.id, "not-sent");
          }
          setThreadError(send.threadId, errorMessage(error));
          break;
        }
      }
      if (send.isCurrentSend()) {
        sendInFlightRef.current = false;
        resetLocalDispatch();
      }
      released = true;
      await Promise.all(requests);
      const attempts =
        usePromptStashStore.getState().entries.find((entry) => entry.id === entryId)?.recovery
          ?.fanout?.attempts ?? [];
      const accepted = attempts.filter((attempt) => attempt.outcome === "accepted").length;
      const allAccepted =
        attempts.length === fanout.attempts.length && accepted === attempts.length;
      const cleanup = usePromptStashStore
        .getState()
        .settleSendRecovery(entryId, allAccepted && !retryAtSend);
      reserved = false;
      if (allAccepted && send.usesAttachmentUploads)
        releaseDraftAttachments(send.sendSnapshot.attachments);
      if (!allAccepted || !cleanup.durable || (retryAtSend && outcomeWriteFailed))
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Fanout recovery saved in the prompt stash",
            timeout: 0,
            description: `${accepted} accepted; ${attempts.filter((attempt) => attempt.outcome === "failed" || attempt.outcome === "not-sent").length} failed or not sent; ${attempts.filter((attempt) => attempt.outcome === "uncertain").length} uncertain. Restore failed models from the stash. Check uncertain threads before explicitly retrying.${outcomeWriteFailed ? " Some outcomes could not be saved; after reload treat them as uncertain and check their threads." : ""}`,
            ...(draftId
              ? {
                  actionProps: {
                    children: "Open recovery draft",
                    onClick: () => {
                      void navigate({ to: "/draft/$draftId", params: { draftId } });
                    },
                  },
                }
              : {}),
          }),
        );
      else
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: `Environment accepted ${accepted} model sends`,
          }),
        );
    } catch (error) {
      setThreadError(send.threadId, errorMessage(error));
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: invoked ? "Fanout could not finish" : "Fanout was not sent",
          description: `${errorMessage(error)} ${cleared ? "The recovery copy remains in the prompt stash." : "Your draft is unchanged."}`,
        }),
      );
    } finally {
      if (reserved) usePromptStashStore.getState().settleSendRecovery(entryId, !cleared);
      if (!released && send.isCurrentSend()) {
        sendInFlightRef.current = false;
        resetLocalDispatch();
      }
    }
  };
}
