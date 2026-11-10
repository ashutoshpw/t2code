import {
  AuthOrchestrationOperateScope,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatAttachment,
  type ComposerContextDraft,
  type EnvironmentId,
  type MessageId,
  type OrchestrationMessageContext,
  type RunId,
  type ThreadId,
} from "@t2code/contracts";
import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import {
  MAX_STASH_ENTRIES,
  MAX_STASH_ENTRY_ATTACHMENT_CHARS,
  usePromptStashStore,
} from "../../promptStashStore";
import { reserveComposerSendRecovery } from "../../lib/composerSendRecovery";
import { composerDraftSendGuard } from "../../lib/prepareComposerSendContext";
import {
  startAttachmentUpload,
  awaitAttachmentUploads,
  getUploadedAttachments,
} from "../../lib/attachmentUploadQueue";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { randomUUID } from "../../lib/utils";

export async function recoverQueuedMessageEdit(input: {
  readonly editTarget: ComposerThreadTarget;
  readonly threadTarget: ComposerThreadTarget;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
  readonly originalAttachments: ReadonlyArray<ChatAttachment>;
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
  readonly saveOutcome: "not-sent" | "uncertain" | "accepted";
  readonly isCurrent: () => boolean;
}) {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(input.editTarget) ?? {
    prompt: "",
    images: [],
    files: [],
    terminalContexts: [],
    reviewComments: [],
    previewAnnotations: [],
    threadContexts: [],
    contextDraft: undefined,
  };
  const originalContextDraft: ComposerContextDraft = {
    selectors: [],
    records: (input.context?.records ?? []).filter(
      (record) => record.kind === "page" || record.kind === "block",
    ),
  };
  const changed =
    draft.prompt !== input.originalText ||
    draft.images.length > 0 ||
    draft.files.length > 0 ||
    draft.terminalContexts.length > 0 ||
    draft.reviewComments.length > 0 ||
    draft.previewAnnotations.length > 0 ||
    draft.threadContexts.length > 0 ||
    JSON.stringify(draft.contextDraft ?? { selectors: [], records: [] }) !==
      JSON.stringify(originalContextDraft) ||
    JSON.stringify(input.existingAttachments) !== JSON.stringify(input.originalAttachments);
  if (!changed) return null;
  if (usePromptStashStore.getState().entries.length >= MAX_STASH_ENTRIES)
    throw new Error(
      "The prompt stash is full. Free a slot and retry recovery; this edit stays open.",
    );
  if (
    draft.images.length + draft.files.length + input.existingAttachments.length >
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS
  )
    throw new Error(
      "This edit has too many attachments to recover. Keep it open and remove an attachment.",
    );
  const attachmentIds = [...draft.images, ...draft.files, ...input.existingAttachments].map(
    (attachment) => attachment.id,
  );
  if (new Set(attachmentIds).size !== attachmentIds.length)
    throw new Error(
      "Duplicate attachment identities cannot be recovered safely. Keep this edit open and remove the duplicate reference.",
    );
  const estimatedChars = [
    ...draft.images,
    ...input.existingAttachments.filter((a) => a.type === "image"),
  ].reduce(
    (total, image) =>
      total + `data:${image.mimeType};base64,`.length + 4 * Math.ceil(image.sizeBytes / 3),
    0,
  );
  if (estimatedChars > MAX_STASH_ENTRY_ATTACHMENT_CHARS)
    throw new Error(
      "This edit's original images exceed the recovery limit. Keep this tab open and reduce images before retrying recovery.",
    );
  const unchanged = composerDraftSendGuard(input.editTarget);
  const assertCurrent = () => {
    const current = store.getComposerDraft(input.editTarget);
    const filesCurrent =
      (current?.files ?? []).length === draft.files.length &&
      draft.files.every((file, index) => {
        const next = current?.files[index];
        return (
          next?.id === file.id &&
          next.file === file.file &&
          next.name === file.name &&
          next.mimeType === file.mimeType &&
          next.sizeBytes === file.sizeBytes &&
          next.source === file.source
        );
      });
    const imagesCurrent =
      (current?.images ?? []).length === draft.images.length &&
      draft.images.every((image, index) => current?.images[index] === image);
    if (!input.isCurrent() || !unchanged() || !filesCurrent || !imagesCurrent)
      throw new Error(
        "The edit changed during recovery. The current edit stays open; retry recovery.",
      );
  };
  const filesWithoutHandles = draft.files.filter(
    (file) => !file.uploadedAttachmentId || file.uploadEnvironmentId !== input.environmentId,
  );
  if (filesWithoutHandles.length) {
    const connection = readPreparedConnection(input.environmentId);
    const canUpload = () => {
      assertCurrent();
      if (
        !connection ||
        readPreparedConnection(input.environmentId) !== connection ||
        !readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)
      )
        throw new Error(
          "Reconnect with upload permission and retry recovery. The original files stay in this edit.",
        );
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(input.environmentId);
      const reason = fileAttachmentCapabilityBlockReason({
        files: filesWithoutHandles,
        attachmentUploadsCapabilityKnown: config !== undefined,
        supportsAttachmentUploads: config?.environment.capabilities.attachmentUploads === true,
        maxFileAttachmentBytes:
          config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
      });
      if (reason) throw new Error(reason);
    };
    canUpload();
    for (const file of filesWithoutHandles)
      startAttachmentUpload({
        environmentId: input.environmentId,
        image: file,
        draftTarget: input.editTarget,
      });
    await awaitAttachmentUploads(filesWithoutHandles.map((file) => file.id));
    assertCurrent();
    if (
      getUploadedAttachments({
        environmentId: input.environmentId,
        images: filesWithoutHandles,
      }) === null
    )
      throw new Error(
        "Could not retain all files. Keep this edit open, retry uploads and recovery.",
      );
    if (
      !connection ||
      readPreparedConnection(input.environmentId) !== connection ||
      !readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)
    )
      throw new Error("The connection changed. Keep this edit open and retry recovery.");
  }
  const assertReady = assertCurrent;
  const keptRecords = (input.context?.records ?? []).filter(
    (record) =>
      record.kind !== "page" &&
      record.kind !== "block" &&
      (!("attachmentId" in record) ||
        input.existingAttachments.some((attachment) => attachment.id === record.attachmentId)),
  );
  const id = `queued-edit:${randomUUID()}`;
  await reserveComposerSendRecovery({
    id,
    environmentId: input.environmentId,
    threadId: input.threadId,
    draftId: null,
    target: input.threadTarget,
    contents: {
      prompt: draft.prompt,
      images: draft.images,
      files: store.getComposerDraft(input.editTarget)?.files ?? draft.files,
      terminalContexts: draft.terminalContexts,
      reviewComments: draft.reviewComments,
      previewAnnotations: draft.previewAnnotations,
      threadContexts: draft.threadContexts,
      contextDraft: {
        selectors: draft.contextDraft?.selectors ?? [],
        records: [...keptRecords, ...(draft.contextDraft?.records ?? [])],
      },
    },
    assertCurrent: assertReady,
    queuedEdit: {
      runId: input.runId,
      messageId: input.messageId,
      attachments: input.existingAttachments,
      saveOutcome: input.saveOutcome,
    },
  });
  try {
    assertReady();
  } catch (error) {
    usePromptStashStore.getState().settleSendRecovery(id, false);
    throw error;
  }
  return { entryId: id, assertCurrent: assertReady };
}

export async function prepareQueuedEditAttachments(input: {
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly uploadFiles: (
    files: ReadonlyArray<ComposerFileAttachment>,
  ) => Promise<ReadonlyArray<ChatAttachment>>;
  readonly readImage: (file: File) => Promise<string>;
}) {
  const files = input.files.length === 0 ? [] : await input.uploadFiles(input.files);
  if (files.length !== input.files.length)
    throw new Error("Retry or remove failed uploads before saving.");
  const images = await Promise.all(
    input.images.map(async (image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await input.readImage(image.file),
      ...(image.source ? { source: image.source } : {}),
    })),
  );
  return [...input.existingAttachments, ...images, ...files];
}
