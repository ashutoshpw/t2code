import {
  FanoutRecovery,
  draftFanoutSelectionsAtom,
  fanoutSelectionKey,
  type FanoutRetry,
} from "./composerFanout";
import { appAtomRegistry } from "../rpc/atomRegistry";
import * as Schema from "effect/Schema";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  AuthFilesystemReadScope,
  ChatImageAttachment,
  ChatFileAttachment,
  type EnvironmentId,
  type ThreadId,
} from "@t2code/contracts";
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
import {
  MAX_STASH_ENTRY_ATTACHMENT_CHARS,
  MAX_STASH_ENTRIES,
  usePromptStashStore,
  type PromptStashEntry,
} from "../promptStashStore";
import { readAttachmentUpload, verifyStashedAttachmentUpload } from "./attachmentUploadQueue";
import { readFileAsDataUrl } from "./imageCompression";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import { assetEnvironment } from "../state/assets";
import { executeAtomQuery } from "@t2code/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t2code/client-runtime/state/assets";
const isImageAttachment = Schema.is(ChatImageAttachment);
const isFileAttachment = Schema.is(ChatFileAttachment);

async function queuedRecoveryImages(input: {
  environmentId: EnvironmentId;
  descriptors: ReadonlyArray<ChatImageAttachment>;
  existingImages: ReadonlyArray<PersistedComposerImageAttachment>;
  assertAccess: () => void;
}) {
  const { environmentId, assertAccess } = input;
  const descriptors = input.descriptors.filter(
    (image) => !input.existingImages.some((saved) => saved.id === image.id),
  );
  let chars = input.existingImages.reduce((total, image) => total + image.dataUrl.length, 0);
  const images: PersistedComposerImageAttachment[] = [];
  for (const descriptor of descriptors) {
    const estimated =
      `data:${descriptor.mimeType};base64,`.length + 4 * Math.ceil(descriptor.sizeBytes / 3);
    if (chars + estimated > MAX_STASH_ENTRY_ATTACHMENT_CHARS)
      throw new Error("The queued images exceed recovery capacity.");
    assertAccess();
    const connection = readPreparedConnection(environmentId)!;
    const result = await executeAtomQuery(
      appAtomRegistry,
      assetEnvironment.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "attachment",
            attachmentId: descriptor.id,
            fileName: descriptor.name,
            mimeType: descriptor.mimeType,
          },
        },
      }),
      { reportFailure: false, refresh: true },
    );
    assertAccess();
    if (result._tag !== "Success") throw new Error("A queued image is unavailable.");
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
    if (!url) throw new Error("The environment returned an invalid queued image URL.");
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body)
      throw new Error("Could not read the original queued image.");
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    try {
      while (true) {
        const next = await reader.read();
        assertAccess();
        if (next.done) break;
        received += next.value.byteLength;
        if (received > descriptor.sizeBytes)
          throw new Error("The queued image exceeds its declared byte limit.");
        chunks.push(new Uint8Array(next.value));
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (received !== descriptor.sizeBytes) throw new Error("The queued image is incomplete.");
    const file = new File(chunks, descriptor.name, { type: descriptor.mimeType });
    const dataUrl = await readFileAsDataUrl(file);
    assertAccess();
    chars += dataUrl.length;
    if (chars > MAX_STASH_ENTRY_ATTACHMENT_CHARS)
      throw new Error("The queued images exceed recovery capacity.");
    images.push({
      id: descriptor.id,
      name: descriptor.name,
      mimeType: descriptor.mimeType,
      sizeBytes: descriptor.sizeBytes,
      dataUrl,
      ...(descriptor.source ? { source: descriptor.source } : {}),
    });
  }
  return images;
}

const decodeFanoutRecovery = Schema.decodeSync(FanoutRecovery);

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

export function assertFanoutRecoveryAdmission(input: {
  environmentId: EnvironmentId;
  target: ComposerThreadTarget;
  prompt: string;
  retry: FanoutRetry | undefined;
  ownEntryId?: string;
}) {
  const entries = usePromptStashStore.getState().entries;
  if (entries.length > MAX_STASH_ENTRIES)
    throw new Error("Review the prompt stash before sending; recovery ownership is unavailable.");
  const targetKey = composerTargetKey(input.target);
  const matchesOrigin = (entry: (typeof entries)[number]) =>
    entry.recovery?.fanout &&
    entry.recovery.environmentId === input.environmentId &&
    entry.recovery.targetKey === targetKey &&
    entry.prompt === input.prompt;
  const retryIndex = input.retry
    ? entries.findIndex((entry) => entry.id === input.retry!.entryId && matchesOrigin(entry))
    : -1;
  if (input.retry && retryIndex < 0)
    throw new Error("The fanout recovery entry changed. Review the stash before retrying.");
  const keys = new Set(input.retry?.selections.map(fanoutSelectionKey));
  for (const [index, entry] of entries.entries()) {
    if (entry.id === input.ownEntryId || !matchesOrigin(entry)) continue;
    if (!input.retry)
      throw new Error(
        "Use fanout recovery to review earlier model outcomes before sending this prompt again, or start a fresh draft.",
      );
    const chosen = entry.recovery!.fanout!.attempts.filter((attempt) =>
      keys.has(fanoutSelectionKey(attempt.selection)),
    );
    if (index === retryIndex) {
      if (
        chosen.length !== keys.size ||
        chosen.some(
          (attempt) =>
            attempt.outcome === "accepted" ||
            (attempt.outcome === "uncertain" && !input.retry!.uncertain),
        )
      )
        throw new Error("Review fanout recovery before retrying accepted or uncertain models.");
    } else if (
      index < retryIndex &&
      chosen.some((attempt) => attempt.outcome === "accepted" || attempt.outcome === "uncertain")
    )
      throw new Error(
        "A newer fanout attempt was accepted or remains uncertain. Review that recovery entry and check its thread before retrying.",
      );
  }
}

export async function reserveComposerSendRecovery(input: {
  id: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId: DraftId | null;
  target: ComposerThreadTarget;
  contents: RecoveryContents;
  assertCurrent: () => void;
  fanout?: FanoutRecovery;
  queuedEdit?: NonNullable<PromptStashEntry["recovery"]>["queuedEdit"];
}) {
  if (input.fanout) decodeFanoutRecovery(input.fanout);
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
  if (input.queuedEdit) {
    const descriptors = input.queuedEdit.attachments.filter(isImageAttachment);
    const connection = readPreparedConnection(input.environmentId);
    const assertAccess = () => {
      input.assertCurrent();
      if (
        descriptors.length &&
        (!connection ||
          readPreparedConnection(input.environmentId) !== connection ||
          !readEnvironmentScope(input.environmentId, AuthFilesystemReadScope))
      )
        throw new Error(
          "Reconnect with attachment read permission before saving queued image recovery. The edit stays open.",
        );
    };
    attachments.push(
      ...(await queuedRecoveryImages({
        environmentId: input.environmentId,
        descriptors,
        existingImages: attachments,
        assertAccess,
      })),
    );
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
      ...(input.fanout ? { fanout: structuredClone(input.fanout) } : {}),
      ...(input.queuedEdit ? { queuedEdit: structuredClone(input.queuedEdit) } : {}),
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
  fanoutAttemptIds?: ReadonlyArray<string>;
  allowUncertain?: boolean;
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
  const fanout = entry.recovery.fanout;
  const originalDraft = useComposerDraftStore.getState().getComposerDraft(input.target);
  const originalSession = entry.recovery.draftId
    ? useComposerDraftStore.getState().getDraftSession(entry.recovery.draftId as DraftId)
    : null;
  let retry: FanoutRetry | undefined;
  if (fanout) {
    if (!entry.recovery.draftId || !originalSession)
      throw new Error("Open the original draft before restoring fanout models.");
    const attempts = fanout.attempts.filter((attempt) =>
      input.fanoutAttemptIds
        ? input.fanoutAttemptIds.includes(attempt.id)
        : attempt.outcome === "failed" || attempt.outcome === "not-sent",
    );
    if (
      !attempts.length ||
      (input.fanoutAttemptIds &&
        (new Set(input.fanoutAttemptIds).size !== input.fanoutAttemptIds.length ||
          input.fanoutAttemptIds.length !== attempts.length)) ||
      attempts.some(
        (attempt) =>
          attempt.outcome === "accepted" ||
          (attempt.outcome === "uncertain" && !input.allowUncertain),
      )
    )
      throw new Error(
        "No definite failed models selected. Check uncertain threads before explicitly allowing a retry.",
      );
    retry = {
      routeKey: fanout.routeKey,
      projectId: fanout.projectId,
      branch: fanout.branch,
      runtimeMode: fanout.runtimeMode,
      startFromOrigin: fanout.startFromOrigin,
      entryId: entry.id,
      selections: attempts.map((attempt) => attempt.selection),
      uncertain: attempts.some((attempt) => attempt.outcome === "uncertain"),
    };
  }
  const queued = entry.recovery.queuedEdit?.attachments ?? [];
  if (queued.some((attachment) => !isImageAttachment(attachment) && !isFileAttachment(attachment)))
    throw new Error(
      "This queued recovery contains an unsupported attachment. Its original handle remains saved; no attachment was dropped.",
    );
  const remoteFiles = queued
    .filter(isFileAttachment)
    .map((file) => ({ ...file, attachmentId: file.id, environmentId: input.environmentId }));
  const savedFiles = [...(entry.files ?? []), ...remoteFiles];
  const queuedImages = queued
    .filter(isImageAttachment)
    .filter((image) => !entry.attachments.some((saved) => saved.id === image.id));
  const imageIds = new Set([...entry.attachments, ...queuedImages].map((image) => image.id));
  const fileIds = new Set(savedFiles.map((file) => file.id));
  if (
    entry.attachments.length + queuedImages.length + savedFiles.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
    imageIds.size !== entry.attachments.length + queuedImages.length ||
    fileIds.size !== savedFiles.length ||
    !composerTargetKey(input.target)
  )
    throw new Error(
      "Could not restore all saved attachments. The recovery prompt remains in the stash.",
    );
  const needsQueuedAccess = remoteFiles.length > 0 || queuedImages.length > 0;
  const queuedSession = needsQueuedAccess ? readPreparedConnection(input.environmentId) : null;
  const assertQueuedAccess = () => {
    if (!needsQueuedAccess) return;
    if (
      needsQueuedAccess &&
      (!queuedSession ||
        readPreparedConnection(input.environmentId) !== queuedSession ||
        !readEnvironmentScope(input.environmentId, AuthFilesystemReadScope))
    )
      throw new Error(
        "Reconnect with attachment read access in the original environment before restoring queued attachments.",
      );
    if (
      !canRestore() ||
      usePromptStashStore.getState().entries.find((candidate) => candidate.id === entry.id) !==
        entry
    )
      throw new Error("The composer or recovery changed while reading queued attachments.");
  };
  assertQueuedAccess();
  const remoteImages = await queuedRecoveryImages({
    environmentId: input.environmentId,
    descriptors: queuedImages,
    existingImages: entry.attachments,
    assertAccess: assertQueuedAccess,
  });
  const verifications = await Promise.all(
    savedFiles.map((file) =>
      verifyStashedAttachmentUpload({
        environmentId: input.environmentId,
        attachmentId: file.attachmentId,
      }),
    ),
  );
  assertQueuedAccess();
  if (
    !canRestore() ||
    (fanout &&
      (useComposerDraftStore.getState().getComposerDraft(input.target) !== originalDraft ||
        useComposerDraftStore.getState().getDraftSession(entry.recovery.draftId as DraftId) !==
          originalSession)) ||
    usePromptStashStore.getState().entries.find((candidate) => candidate.id === entry.id) !== entry
  )
    throw new Error(
      "The draft or recovery changed while restoring. Try again when the original composer is empty.",
    );
  const images = hydrateImagesFromPersisted([...entry.attachments, ...remoteImages]);
  if (images.length !== entry.attachments.length + remoteImages.length)
    throw new Error("Could not read saved images. The recovery prompt remains in the stash.");
  const store = useComposerDraftStore.getState();
  const context = entry.recovery.context;
  const acceptedImages = store.addImages(input.target, images, { allowDuplicates: true });
  const expiredFiles: string[] = [];
  const acceptedFiles = store.addFiles(
    input.target,
    savedFiles.map((file, index) => {
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
    { allowDuplicates: true },
  );
  if (acceptedImages.length !== images.length || acceptedFiles.length !== savedFiles.length) {
    for (const id of acceptedImages) store.removeImage(input.target, id);
    for (const id of acceptedFiles) store.removeFile(input.target, id);
    throw new Error(
      "Could not restore all saved attachments. The recovery prompt remains in the stash.",
    );
  }
  store.setContextDraft(input.target, context.contextDraft);
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
  store.setFanoutRetry(input.target, retry);
  if (retry) {
    store.setModelSelection(input.target, retry.selections[0]!);
    appAtomRegistry.set(draftFanoutSelectionsAtom(retry.routeKey), retry.selections);
  }
  // Keep the durable copy until explicit deletion; composer persistence is debounced.
  return {
    prompt: entry.prompt,
    images,
    files: store.getComposerDraft(input.target)?.files ?? [],
    terminalContexts: store.getComposerDraft(input.target)?.terminalContexts ?? [],
    expiredFiles,
    fanoutRetry: retry,
  };
}
