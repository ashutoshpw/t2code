import {
  composerDraftSendGuard,
  prepareComposerSendContext,
} from "../../lib/prepareComposerSendContext";
import { AuthOrchestrationOperateScope, type ComposerContextDraft } from "@t2code/contracts";
import { useNavigate } from "@tanstack/react-router";
import { readEnvironmentScope } from "../../state/session";
import { usePromptStashStore, MAX_STASH_ENTRIES } from "../../promptStashStore";
import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useAtomValue } from "@effect/atom-react";
import { makeQueuedRunEditStore, makeQueuedRunsAtom } from "@t2code/client-runtime/queued-run-edit";
import type { ThreadStructure } from "@t2code/client-runtime/state/shell";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatAttachment,
  type EnvironmentId,
  type MessageId,
  type OrchestrationMessageContext,
  type PreviewAnnotationPayload,
  type RunId,
  type ScopedThreadRef,
  type ThreadContextRecord,
  type ThreadId,
} from "@t2code/contracts";
import { scopedThreadKey } from "@t2code/client-runtime/environment";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t2code/shared/composerContextReferences";
import { Atom } from "effect/reactivity";
import type { RefObject } from "react";
import { useAssetUrls } from "../../assets/assetUrls";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { buildMessageContext } from "../../lib/composerContextRecords";
import { readFileAsDataUrl } from "../../lib/imageCompression";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ChatComposerHandle } from "./ChatComposer";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { prepareQueuedEditAttachments, recoverQueuedMessageEdit } from "./queuedMessageEdit";
import type { EditQueuedRunRequest } from "./QueuedRunsControl";

interface EditingQueuedRun {
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
const queuedRunEdits = makeQueuedRunEditStore<EditingQueuedRun>({
  registry: appAtomRegistry,
  label: "web-queued-run-edits",
});

if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (event) => {
    if (
      Object.keys(appAtomRegistry.get(queuedRunEdits.exitedAtom)).length ||
      Object.keys(appAtomRegistry.get(queuedRunEdits.savingAtom)).length
    ) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

async function recoverExitedQueuedRun(input: {
  key: string;
  environmentId: EnvironmentId;
  routeThreadRef: ScopedThreadRef;
  threadTarget: ComposerThreadTarget;
  open: () => void;
}) {
  const claim = queuedRunEdits.startRecovery(input.key);
  if (!claim) return;
  const edit = claim.edit;
  const target = queuedEditDraftTarget(input.routeThreadRef, edit.runId);
  const unchanged = composerDraftSendGuard(target);
  let entryId: string | null = null;
  try {
    const recovery = await recoverQueuedMessageEdit({
      editTarget: target,
      threadTarget: input.threadTarget,
      environmentId: input.environmentId,
      threadId: edit.threadId,
      runId: edit.runId,
      messageId: edit.messageId,
      originalText: edit.originalText,
      originalAttachments: edit.originalAttachments,
      existingAttachments: edit.existingAttachments,
      context: edit.context,
      saveOutcome: edit.saveOutcome,
      isCurrent: claim.isCurrent,
    });
    entryId = recovery?.entryId ?? null;
    recovery?.assertCurrent();
    if (!claim.isCurrent() || !unchanged())
      throw new Error(
        "The edit changed while recovery was saving. The current edit stays open; retry recovery.",
      );
    useComposerDraftStore.getState().clearComposerContent(target);
    claim.finish(true);
    if (entryId) usePromptStashStore.getState().settleSendRecovery(entryId, false);
    if (entryId)
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Queued edit recovery saved",
          timeout: 0,
          description: `The run left the queue. Your exact edit is in the prompt stash in its original thread. Restore it into an empty composer as a new send.${edit.saveOutcome === "uncertain" ? " The earlier edit request may have committed; check the thread before sending again." : edit.saveOutcome === "accepted" ? " The earlier edit request was accepted; this copy contains later unsaved changes." : " No new queued edit was sent."}`,
          actionProps: { children: "Open original thread", onClick: input.open },
        }),
      );
  } catch (error) {
    if (entryId) usePromptStashStore.getState().settleSendRecovery(entryId, false);
    claim.finish(false);
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Queued edit kept open for recovery",
        timeout: 0,
        description: `${error instanceof Error ? error.message : "Recovery could not be saved."} Keep this tab open until recovery succeeds; local bytes and original attachment handles remain owned by the edit.`,
        actionProps: { children: "Retry recovery", onClick: () => recoverExitedQueuedRun(input) },
        data: { secondaryActionProps: { children: "Open edit", onClick: input.open } },
      }),
    );
  }
}

export interface QueuedRunEditContent {
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly contextDraft?: ComposerContextDraft | undefined;
}

function queuedEditDraftTarget(routeThreadRef: ScopedThreadRef, runId: RunId) {
  return DraftId.make(`queued-edit:${scopedThreadKey(routeThreadRef)}:${runId}`);
}

async function submitQueuedRunEdit(input: {
  readonly environmentId: EnvironmentId;
  readonly draftTarget: ComposerThreadTarget;
  readonly editing: EditingQueuedRun;
  readonly content: QueuedRunEditContent;
  readonly editQueuedRun: ReturnType<typeof useEditQueuedRunCommand>;
  readonly isCurrentQueued: () => boolean;
  readonly markSaveOutcome: (outcome: "uncertain" | "accepted") => void;
}): Promise<string | null> {
  const { environmentId, draftTarget, editing, content } = input;
  const editText = content.prompt.trim();
  const draftStillCurrent = composerDraftSendGuard(draftTarget);
  const newAttachments = [...content.images, ...content.files];
  const uploadFiles = async (files: ReadonlyArray<ComposerFileAttachment>) => {
    const validateFiles = () => {
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
      const reason = fileAttachmentCapabilityBlockReason({
        files,
        attachmentUploadsCapabilityKnown: config !== null,
        supportsAttachmentUploads: config?.environment.capabilities.attachmentUploads === true,
        maxFileAttachmentBytes:
          config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
      });
      if (reason !== null) throw new Error(reason);
    };
    validateFiles();
    for (const file of files) startAttachmentUpload({ environmentId, image: file, draftTarget });
    await awaitAttachmentUploads(files.map((file) => file.id));
    validateFiles();
    const uploaded = getUploadedAttachments({ environmentId, images: files });
    if (uploaded === null) throw new Error("Retry or remove failed uploads before saving.");
    return uploaded;
  };
  try {
    const uploads = await prepareQueuedEditAttachments({
      existingAttachments: editing.existingAttachments,
      images: content.images,
      files: content.files,
      readImage: readFileAsDataUrl,
      uploadFiles,
    });
    const keptRecords = (editing.context?.records ?? []).filter(
      (record) =>
        !("attachmentId" in record) ||
        editing.existingAttachments.some((attachment) => attachment.id === record.attachmentId),
    );
    const newRecords =
      buildMessageContext({
        terminalContexts: content.terminalContexts.filter(
          (context) => context.text.trim().length > 0,
        ),
        reviewComments: content.reviewComments,
        previewAnnotations: content.previewAnnotations,
        threadContexts: content.threadContexts,
        attachments: newAttachments.map((attachment, index) => ({
          attachment,
          attachmentId: uploads[editing.existingAttachments.length + index]?.id ?? attachment.id,
        })),
      })?.records ?? [];
    const prepared = await prepareComposerSendContext({
      environmentId,
      text: editText,
      contextDraft: content.contextDraft,
      context: {
        version: 1,
        ...(editing.context?.guest ? { guest: editing.context.guest } : {}),
        records: [
          ...new Map(
            [
              ...keptRecords.filter((record) => record.kind !== "page" && record.kind !== "block"),
              ...newRecords,
            ].map((record) => [record.contextId, record] as const),
          ).values(),
        ],
      },
      isCurrentDraft: draftStillCurrent,
    });
    prepared.assertCurrent();
    if (!draftStillCurrent() || !input.isCurrentQueued())
      throw new Error(
        "The queued edit changed or left the queue. The unsaved edit is retained for recovery.",
      );
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      throw new Error("This connection cannot change queued messages.");
    input.markSaveOutcome("uncertain");
    const result = await input.editQueuedRun({
      environmentId,
      input: {
        threadId: editing.threadId,
        runId: editing.runId,
        text: editText.length === 0 ? ATTACHMENT_ONLY_BOOTSTRAP_PROMPT : editText,
        edit: {
          messageId: editing.messageId,
          attachments: uploads,
          ...(prepared.context ? { context: prepared.context } : {}),
        },
      },
    });
    if (result._tag === "Success") input.markSaveOutcome("accepted");
    return result._tag === "Failure"
      ? "Could not save the edited queued message. Check the thread; its outcome may be uncertain."
      : null;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not save the edited queued message.";
  }
}

function useEditQueuedRunCommand() {
  return useAtomCommand(threadEnvironment.editQueuedRun, { reportFailure: false });
}

/** Edits preserve the thread draft; attachment removals stay local until save. */
export function useQueuedRunEdit(input: {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly threadDraftTarget: ComposerThreadTarget;
  readonly activeThreadId: ThreadId | null;
  readonly serverProjection: ThreadStructure | null;
  readonly promptRef: { current: string };
  readonly composerRef: RefObject<ChatComposerHandle | null>;
}) {
  const {
    environmentId,
    routeThreadRef,
    threadDraftTarget,
    activeThreadId,
    serverProjection,
    promptRef,
    composerRef,
  } = input;
  const navigate = useNavigate();
  const editQueuedRunCommand = useEditQueuedRunCommand();
  const editKey = scopedThreadKey(routeThreadRef);
  const storedEdit = useAtomValue(queuedRunEdits.atom)[editKey] ?? null;
  const editing = activeThreadId === null ? null : storedEdit;
  const isSaving = useAtomValue(queuedRunEdits.savingAtom)[editKey] === true;
  const hasLeftQueue = useAtomValue(queuedRunEdits.exitedAtom)[editKey] === true;
  const draftTarget =
    editing === null ? threadDraftTarget : queuedEditDraftTarget(routeThreadRef, editing.runId);

  const imageResources = (editing?.existingAttachments ?? [])
    .filter((attachment) => attachment.type === "image")
    .map((attachment) => ({ _tag: "attachment" as const, attachmentId: attachment.id }));
  const imageUrls = useAssetUrls(environmentId, imageResources);
  const urlByAttachmentId = new Map(
    imageResources.map((resource, index) => [resource.attachmentId, imageUrls[index] ?? null]),
  );
  const editingAttachments =
    editing === null
      ? null
      : editing.existingAttachments.map((attachment) => ({
          attachment,
          url: urlByAttachmentId.get(attachment.id) ?? null,
        }));

  const focusComposerSoon = () => {
    window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  };
  const clearEditDraft = (runId: RunId) =>
    useComposerDraftStore
      .getState()
      .clearComposerContent(queuedEditDraftTarget(routeThreadRef, runId));

  const recoveryInput = {
    key: editKey,
    environmentId,
    routeThreadRef,
    threadTarget: threadDraftTarget,
    open: () => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: routeThreadRef.threadId },
      });
    },
  };
  const beginEdit = useStableCallback((request: EditQueuedRunRequest) => {
    if (activeThreadId === null) return;
    if (
      appAtomRegistry.get(queuedRunEdits.exitedAtom)[editKey] ||
      (queuedRunEdits.get(editKey) !== null && !queuedRunEdits.isQueued(editKey)) ||
      (!queuedRunEdits.get(editKey) &&
        Object.keys(appAtomRegistry.get(queuedRunEdits.atom)).length >= MAX_STASH_ENTRIES)
    ) {
      toastManager.add({
        type: "warning",
        title: "Keep the retained queued edit",
        description:
          "Finish recovery of the existing edit before opening another. At most 20 queued edits can stay open.",
      });
      return;
    }
    if (editing !== null && editing.runId !== request.runId) clearEditDraft(editing.runId);
    const target = queuedEditDraftTarget(routeThreadRef, request.runId);
    const store = useComposerDraftStore.getState();
    store.clearComposerContent(target);
    store.setPrompt(target, request.text);
    const previousContext = serverProjection?.messages.find(
      (message) => message.id === request.messageId,
    )?.context;
    store.setContextDraft(target, {
      selectors: [],
      records: (previousContext?.records ?? []).filter(
        (record) => record.kind === "page" || record.kind === "block",
      ),
    });
    const threadRef = { environmentId, threadId: activeThreadId };
    queuedRunEdits.begin(
      editKey,
      {
        id: randomUUID(),
        originalAttachments: request.attachments,
        saveOutcome: "not-sent",
        threadId: activeThreadId,
        runId: request.runId,
        messageId: request.messageId,
        originalText: request.text,
        existingAttachments: request.attachments,
        context: serverProjection?.messages.find((message) => message.id === request.messageId)
          ?.context,
      },
      {
        retainOnExit: true,
        runs: makeQueuedRunsAtom({
          threadId: activeThreadId,
          snapshot: threadEnvironment.snapshotAtom(environmentId),
          detailStatus: environmentThreadDetails.statusAtom(threadRef),
          runs: Atom.make(
            (get) =>
              get(environmentThreadDetails.quietThreadAtom(threadRef))?.projection.runs ?? null,
          ),
        }),
        onRunLeftQueue: () => {
          void recoverExitedQueuedRun(recoveryInput);
        },
      },
    );
    focusComposerSoon();
  });
  const cancelEdit = useStableCallback(async () => {
    const current = queuedRunEdits.get(editKey);
    if (!current || appAtomRegistry.get(queuedRunEdits.savingAtom)[editKey]) return;
    if (
      appAtomRegistry.get(queuedRunEdits.exitedAtom)[editKey] &&
      !(await readLocalApi()?.dialogs.confirm(
        "Discard this unsaved queued edit and its local attachment bytes? Recovery has not finished.",
      ))
    )
      return;
    if (
      queuedRunEdits.get(editKey) !== current ||
      appAtomRegistry.get(queuedRunEdits.savingAtom)[editKey]
    )
      return;
    clearEditDraft(current.runId);
    queuedRunEdits.end(editKey);
    focusComposerSoon();
  });
  const removeEditingAttachment = useStableCallback((attachmentId: string) => {
    queuedRunEdits.update(editKey, (current) => ({
      ...current,
      existingAttachments: current.existingAttachments.filter(
        (attachment) => attachment.id !== attachmentId,
      ),
    }));
  });

  const saveEdit = async (
    content: QueuedRunEditContent,
    setThreadError: (threadId: ThreadId, error: string | null) => void,
  ) => {
    if (appAtomRegistry.get(queuedRunEdits.exitedAtom)[editKey]) {
      await recoverExitedQueuedRun(recoveryInput);
      return;
    }
    if (editing === null || isSaving) return;
    const newAttachments = [...content.images, ...content.files];
    if (
      editing.existingAttachments.length + newAttachments.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      setThreadError(
        editing.threadId,
        `A message can have at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
      return;
    }
    if (
      content.prompt.trim().length === 0 &&
      editing.existingAttachments.length === 0 &&
      newAttachments.length === 0
    ) {
      return;
    }
    // The save's result decides the edit's fate, even if the run starts meanwhile.
    const finishSave = queuedRunEdits.startSave(editKey);
    if (finishSave === null) return;
    const draftStillCurrent = composerDraftSendGuard(draftTarget);
    const error = await submitQueuedRunEdit({
      environmentId,
      draftTarget,
      editing,
      content,
      editQueuedRun: editQueuedRunCommand,
      isCurrentQueued: () =>
        queuedRunEdits.get(editKey)?.id === editing.id &&
        queuedRunEdits.isQueued(editKey) &&
        JSON.stringify(queuedRunEdits.get(editKey)?.existingAttachments) ===
          JSON.stringify(editing.existingAttachments),
      markSaveOutcome: (outcome) =>
        queuedRunEdits.update(editKey, (current) =>
          current.id === editing.id ? { ...current, saveOutcome: outcome } : current,
        ),
    });
    setThreadError(editing.threadId, error);
    const unchanged =
      draftStillCurrent() &&
      JSON.stringify(queuedRunEdits.get(editKey)?.existingAttachments) ===
        JSON.stringify(editing.existingAttachments);
    const current = finishSave(error === null && unchanged);
    if (error !== null) return;
    // The edit was cancelled or begun again while this save ran; its drafts are the newer edit's.
    if (!current || !unchanged) return;
    releaseDraftAttachments(newAttachments);
    promptRef.current = "";
    clearEditDraft(editing.runId);
    composerRef.current?.resetCursorState();
    focusComposerSoon();
  };

  return {
    editingRunId: editing?.runId ?? null,
    isEditing: editing !== null,
    isSaving,
    hasLeftQueue,
    recoverEdit: () => recoverExitedQueuedRun(recoveryInput),
    draftTarget,
    editingAttachments,
    beginEdit,
    cancelEdit,
    removeEditingAttachment,
    saveEdit,
  };
}
