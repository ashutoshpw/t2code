import type { EnvironmentId, ThreadId } from "@t2code/contracts";
import {
  composerDraftHasUserContent,
  composerTargetKey,
  hydrateImagesFromPersisted,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
  type DraftId,
  type PersistedComposerImageAttachment,
} from "../composerDraftStore";
import { MAX_STASH_ENTRY_ATTACHMENT_CHARS, usePromptStashStore } from "../promptStashStore";
import { readAttachmentUpload, verifyStashedAttachmentUpload } from "./attachmentUploadQueue";
import { readFileAsDataUrl } from "./imageCompression";

type RecoveryState = Pick<
  ComposerThreadDraftState,
  | "prompt"
  | "images"
  | "files"
  | "terminalContexts"
  | "reviewComments"
  | "previewAnnotations"
  | "threadContexts"
  | "contextDraft"
>;
type RecoveryContents = { [Key in keyof RecoveryState]: Readonly<RecoveryState[Key]> };

export async function reserveComposerSendRecovery(input: {
  id: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId: DraftId | null;
  target: ComposerThreadTarget;
  contents: RecoveryContents;
  assertCurrent: () => void;
}) {
  const { images, files, prompt, contextDraft, ...context } = input.contents;
  const attachments: PersistedComposerImageAttachment[] = [];
  let attachmentChars = 0;
  for (const image of images) {
    const estimatedChars =
      `data:${image.file.type || "application/octet-stream"};base64,`.length +
      4 * Math.ceil(image.file.size / 3);
    if (attachmentChars + estimatedChars > MAX_STASH_ENTRY_ATTACHMENT_CHARS)
      throw new Error(
        "This message's images exceed the recovery storage limit. Remove an image before sending.",
      );
    const dataUrl = await readFileAsDataUrl(image.file);
    attachmentChars += dataUrl.length;
    if (attachmentChars > MAX_STASH_ENTRY_ATTACHMENT_CHARS)
      throw new Error(
        "This message's images exceed the recovery storage limit. Remove an image before sending.",
      );
    attachments.push({
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl,
      ...(image.source ? { source: image.source } : {}),
    });
  }
  const persistedFiles = files.map((file) => {
    const upload = readAttachmentUpload(file.id);
    const attachmentId =
      upload?.status === "ready" && upload.environmentId === input.environmentId
        ? upload.attachmentId
        : file.uploadEnvironmentId === input.environmentId
          ? file.uploadedAttachmentId
          : undefined;
    if (!attachmentId) throw new Error("Wait for file uploads before sending this message.");
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      attachmentId,
      environmentId: input.environmentId,
      ...(file.source ? { source: file.source } : {}),
    };
  });
  input.assertCurrent();
  const result = usePromptStashStore.getState().reserveSendRecovery({
    id: input.id,
    createdAt: new Date().toISOString(),
    prompt,
    attachments,
    files: persistedFiles,
    droppedImageNames: [],
    recovery: {
      environmentId: input.environmentId,
      threadId: input.threadId,
      ...(input.draftId ? { draftId: input.draftId } : {}),
      targetKey: composerTargetKey(input.target),
      context: structuredClone({ ...context, ...(contextDraft ? { contextDraft } : {}) }),
    },
  });
  if (!result.durable)
    throw new Error(
      "Could not save send recovery. The prompt stash is full or browser storage is unavailable. Free space in the stash or browser storage and try again; your draft is unchanged.",
    );
  return input.id;
}

export async function restoreComposerSendRecovery(input: {
  entryId: string;
  environmentId: EnvironmentId;
  target: ComposerThreadTarget;
  isCurrent: () => boolean;
}) {
  const stash = usePromptStashStore.getState();
  const entry = stash.entries.find((candidate) => candidate.id === input.entryId);
  if (!entry?.recovery) throw new Error("This recovery prompt is no longer in the stash.");
  if (stash.activeRecoveryIds.includes(entry.id))
    throw new Error("Wait for this send to finish before restoring its prompt.");
  if (
    entry.recovery.environmentId !== input.environmentId ||
    entry.recovery.targetKey !== composerTargetKey(input.target)
  )
    throw new Error("Restore this recovery prompt in its original thread or draft.");
  const canRestore = () =>
    input.isCurrent() &&
    !composerDraftHasUserContent(useComposerDraftStore.getState().getComposerDraft(input.target));
  if (!canRestore())
    throw new Error("Send or clear the current prompt in the original thread before restoring.");
  const verifications = await Promise.all(
    (entry.files ?? []).map((file) =>
      verifyStashedAttachmentUpload({
        environmentId: input.environmentId,
        attachmentId: file.attachmentId,
      }),
    ),
  );
  if (
    !canRestore() ||
    usePromptStashStore.getState().entries.find((candidate) => candidate.id === entry.id) !== entry
  )
    throw new Error(
      "The draft or recovery changed while restoring. Try again when the original composer is empty.",
    );
  const images = hydrateImagesFromPersisted(entry.attachments);
  if (images.length !== entry.attachments.length)
    throw new Error("Could not read saved images. The recovery prompt remains in the stash.");
  const store = useComposerDraftStore.getState();
  const context = entry.recovery.context;
  store.setContextDraft(input.target, context.contextDraft);
  store.addImages(input.target, images);
  const expiredFiles: string[] = [];
  store.addFiles(
    input.target,
    (entry.files ?? []).map((file, index) => {
      const expired = verifications[index]?.status === "missing";
      if (expired) expiredFiles.push(file.name);
      return {
        type: "file" as const,
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        file: null,
        ...(file.source ? { source: file.source } : {}),
        ...(!expired
          ? { uploadedAttachmentId: file.attachmentId, uploadEnvironmentId: file.environmentId }
          : {}),
      };
    }),
  );
  store.setTerminalContexts(
    input.target,
    (context.terminalContexts ?? []).map((terminal) => ({
      ...terminal,
      text: terminal.text ?? "",
    })),
  );
  store.setReviewComments(input.target, [...(context.reviewComments ?? [])]);
  store.setPreviewAnnotations(input.target, [...(context.previewAnnotations ?? [])]);
  store.setThreadContexts(input.target, [...(context.threadContexts ?? [])]);
  store.setPrompt(input.target, entry.prompt);
  // Keep the durable copy until explicit deletion; composer persistence is debounced.
  return {
    prompt: entry.prompt,
    images,
    files: store.getComposerDraft(input.target)?.files ?? [],
    terminalContexts: store.getComposerDraft(input.target)?.terminalContexts ?? [],
    expiredFiles,
  };
}
