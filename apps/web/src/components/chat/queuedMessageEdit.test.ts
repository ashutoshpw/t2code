import { EnvironmentId, MessageId, RunId, ThreadId } from "@t2code/contracts";
import { scopeThreadRef } from "@t2code/client-runtime/environment";
import { threadContextRecord } from "@t2code/shared/composerContextReferences";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { prepareQueuedEditAttachments, recoverQueuedMessageEdit } from "./queuedMessageEdit";

const reserveComposerSendRecovery = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../lib/composerSendRecovery", () => ({ reserveComposerSendRecovery }));

const environmentId = EnvironmentId.make("remote-environment");
const threadTarget = scopeThreadRef(environmentId, ThreadId.make("thread:edit"));
const editTarget = DraftId.make("queued-edit:test");
const file: ComposerFileAttachment = {
  type: "file",
  id: "file:report",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 6,
  file: new File(["report"], "report.pdf", { type: "application/pdf" }),
};
const image: ComposerImageAttachment = {
  type: "image",
  id: "image:screen",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 5,
  file: new File(["image"], "screen.png", { type: "image/png" }),
  previewUrl: "blob:screen",
};
const uploadedFile = {
  type: "file" as const,
  id: "upload:report",
  name: file.name,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
};

describe("queued message file edits", () => {
  beforeEach(() => {
    reserveComposerSendRecovery.mockClear();
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  });

  it.each([
    { images: [], label: "file-only" },
    { images: [image], label: "mixed" },
  ])("preserves a generic file in a $label save", async ({ images }) => {
    const attachments = await prepareQueuedEditAttachments({
      existingAttachments: [],
      images,
      files: [file],
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "data:image/png;base64,aW1hZ2U=",
    });
    expect(attachments.at(-1)).toEqual(uploadedFile);
    expect(attachments.length).toBe(images.length + 1);
    if (images.length > 0)
      expect(attachments[0]).toMatchObject({
        type: "image",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      });
  });

  it("fails a save instead of dropping a file whose upload is missing", async () => {
    await expect(
      prepareQueuedEditAttachments({
        existingAttachments: [],
        images: [image],
        files: [file],
        uploadFiles: async () => [],
        readImage: async () => "image",
      }),
    ).rejects.toThrow("Retry or remove");
  });

  it("removes a kept edit draft that held a thread mention", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Edited message");
    const mention = threadContextRecord(
      scopeThreadRef(environmentId, ThreadId.make("thread:other")),
      "Other",
    );
    store.setThreadContexts(editTarget, [mention]);
    const recovery = await recoverQueuedMessageEdit({
      editTarget,
      threadTarget,
      environmentId,
      threadId: ThreadId.make("thread:edit"),
      runId: RunId.make("run:edit"),
      messageId: MessageId.make("message:edit"),
      originalText: "Original message",
      originalAttachments: [],
      existingAttachments: [],
      saveOutcome: "not-sent",
      isCurrent: () => true,
    });
    expect(recovery).not.toBeNull();
    expect(reserveComposerSendRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: expect.objectContaining({ threadContexts: [mention] }),
      }),
    );
    // The caller clears the edit once the recovery copy is saved.
    store.clearComposerContent(editTarget);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });
});
