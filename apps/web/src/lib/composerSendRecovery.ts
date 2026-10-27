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
} from "../promptStashStore";
import { readAttachmentUpload, verifyStashedAttachmentUpload } from "./attachmentUploadQueue";
import { readFileAsDataUrl } from "./imageCompression";

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
  const savedFiles = entry.files ?? [];
  const imageIds = new Set(entry.attachments.map((image) => image.id));
  const fileIds = new Set(savedFiles.map((file) => file.id));
  if (
    entry.attachments.length + savedFiles.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
    imageIds.size !== entry.attachments.length ||
    fileIds.size !== savedFiles.length ||
    !composerTargetKey(input.target)
  )
    throw new Error(
      "Could not restore all saved attachments. The recovery prompt remains in the stash.",
    );
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
    (fanout &&
      (useComposerDraftStore.getState().getComposerDraft(input.target) !== originalDraft ||
        useComposerDraftStore.getState().getDraftSession(entry.recovery.draftId as DraftId) !==
          originalSession)) ||
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
  const acceptedImages = store.addImages(input.target, images, { allowDuplicates: true });
  const expiredFiles: string[] = [];
  const acceptedFiles = store.addFiles(
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
