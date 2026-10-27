import * as NodeBuffer from "node:buffer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ComposerContextId, EnvironmentId, ThreadId } from "@t2code/contracts";
import { SpacePageId } from "@t2code/contracts/spaces";
import { scopeThreadRef } from "@t2code/client-runtime/environment";
import { prepareSpaceContextSend } from "@t2code/client-runtime/spaces";

const uploads = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("./attachmentUploadQueue", () => ({
  readAttachmentUpload: () => undefined,
  verifyStashedAttachmentUpload: uploads.verify,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function setup() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  });
  const imageReads = vi.fn();
  vi.stubGlobal(
    "FileReader",
    class extends EventTarget {
      result: string | null = null;
      readAsDataURL(blob: Blob) {
        imageReads();
        void blob.arrayBuffer().then((bytes) => {
          this.result = `data:${blob.type};base64,${NodeBuffer.Buffer.from(bytes).toString("base64")}`;
          this.dispatchEvent(new Event("load"));
        });
      }
    },
  );
  vi.resetModules();
  const drafts = await import("../composerDraftStore");
  const stash = await import("../promptStashStore");
  const recovery = await import("./composerSendRecovery");
  const environmentId = EnvironmentId.make("recovery-env");
  const threadId = ThreadId.make("recovery-thread");
  const target = scopeThreadRef(environmentId, threadId);
  drafts.useComposerDraftStore.getState().clearComposerContent(target);
  return { ...recovery, ...drafts, ...stash, environmentId, threadId, target, values, imageReads };
}

it("retains original image bytes, uploaded-file ownership, terminal text and duplicate selector identity across reload", async () => {
  const state = await setup();
  const selector = {
    version: 1 as const,
    selection: "current" as const,
    kind: "page" as const,
    contextId: ComposerContextId.make("duplicate"),
    label: "Page",
    environmentId: state.environmentId,
    pageId: SpacePageId.make("page"),
    includeChildPages: false,
  };
  const file = new File(["original image bytes"], "original.png", { type: "image/png" });
  const contents = {
    prompt: "  [Page](t2-context://v1/terminal/duplicate)  ",
    images: [
      {
        type: "image" as const,
        id: "image",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
        previewUrl: "blob:original",
      },
    ],
    files: [
      {
        type: "file" as const,
        id: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 12,
        file: null,
        uploadedAttachmentId: "uploaded",
        uploadEnvironmentId: state.environmentId,
      },
    ],
    terminalContexts: [
      {
        id: "terminal",
        threadId: state.threadId,
        createdAt: "2026-10-27T00:00:00Z",
        terminalId: "shell",
        terminalLabel: "Shell",
        lineStart: 1,
        lineEnd: 1,
        text: "exact terminal output",
      },
    ],
    reviewComments: [],
    previewAnnotations: [],
    threadContexts: [],
    contextDraft: {
      selectors: [selector, { ...selector, pageId: SpacePageId.make("other-page") }],
      records: [],
    },
  };
  await state.reserveComposerSendRecovery({
    id: "send:image",
    environmentId: state.environmentId,
    threadId: state.threadId,
    draftId: null,
    target: state.target,
    contents,
    assertCurrent: () => {},
  });
  state.usePromptStashStore.getState().settleSendRecovery("send:image", false);
  vi.resetModules();
  const reloadedDrafts = await import("../composerDraftStore");
  const reloadedStash = await import("../promptStashStore");
  const { restoreComposerSendRecovery } = await import("./composerSendRecovery");
  uploads.verify.mockResolvedValue({ status: "missing" });
  const restored = await restoreComposerSendRecovery({
    entryId: "send:image",
    environmentId: state.environmentId,
    target: state.target,
    isCurrent: () => true,
  });
  const draft = reloadedDrafts.useComposerDraftStore.getState().getComposerDraft(state.target)!;
  expect(draft.prompt).toBe(contents.prompt);
  expect(draft.contextDraft).toEqual(contents.contextDraft);
  expect(draft.terminalContexts).toEqual(contents.terminalContexts);
  expect(await draft.images[0]!.file.text()).toBe("original image bytes");
  expect(restored.expiredFiles).toEqual(["report.pdf"]);
  expect(draft.files[0]).toMatchObject({ id: "file", file: null });
  expect(draft.files[0]?.uploadedAttachmentId).toBeUndefined();
  expect(reloadedStash.usePromptStashStore.getState().entries[0]?.files?.[0]).toMatchObject({
    attachmentId: "uploaded",
    environmentId: state.environmentId,
  });
  const capture = vi.fn();
  await expect(
    prepareSpaceContextSend({
      environmentId: state.environmentId,
      text: draft.prompt,
      selectors: draft.contextDraft?.selectors,
      access: () => ({ session: {}, canRead: true, supportsCapture: true }),
      isCurrentDraft: () => true,
      capture,
    }),
  ).rejects.toThrow("Ambiguous Spaces context");
  expect(capture).not.toHaveBeenCalled();
});

it("refuses an oversized image before reading or clearing it", async () => {
  const state = await setup();
  const file = new File([new Uint8Array(2_100_000)], "large.png", { type: "image/png" });
  const store = state.useComposerDraftStore.getState();
  store.setPrompt(state.target, "Keep this image");
  store.addImages(state.target, [
    {
      type: "image",
      id: "large",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
      previewUrl: "blob:large",
    },
  ]);
  const draft = store.getComposerDraft(state.target)!;
  await expect(
    state.reserveComposerSendRecovery({
      id: "send:large",
      environmentId: state.environmentId,
      threadId: state.threadId,
      draftId: null,
      target: state.target,
      contents: draft,
      assertCurrent: () => {},
    }),
  ).rejects.toThrow("images exceed");
  expect(state.imageReads).not.toHaveBeenCalled();
  expect(store.getComposerDraft(state.target)).toBe(draft);
  expect(state.usePromptStashStore.getState().entries).toEqual([]);
});

it("does not replace newer typing while verifying saved file references", async () => {
  const state = await setup();
  let verified!: (value: { status: "ready" }) => void;
  const verification = new Promise<{ status: "ready" }>((resolve) => {
    verified = resolve;
  });
  uploads.verify.mockReturnValue(verification);
  state.usePromptStashStore.getState().reserveSendRecovery({
    id: "send:pending",
    createdAt: "2026-10-27T00:00:00Z",
    prompt: "Original",
    attachments: [],
    files: [
      {
        id: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 12,
        attachmentId: "uploaded",
        environmentId: state.environmentId,
      },
    ],
    droppedImageNames: [],
    recovery: {
      environmentId: state.environmentId,
      threadId: state.threadId,
      targetKey: state.composerTargetKey(state.target),
      context: {},
    },
  });
  state.usePromptStashStore.getState().settleSendRecovery("send:pending", false);
  const pending = state.restoreComposerSendRecovery({
    entryId: "send:pending",
    environmentId: state.environmentId,
    target: state.target,
    isCurrent: () => true,
  });
  state.useComposerDraftStore.getState().setPrompt(state.target, "Newer typing");
  verified({ status: "ready" });
  await expect(pending).rejects.toThrow("draft or recovery changed");
  expect(state.useComposerDraftStore.getState().getComposerDraft(state.target)?.prompt).toBe(
    "Newer typing",
  );
  expect(state.usePromptStashStore.getState().entries).toHaveLength(1);
  await expect(
    state.restoreComposerSendRecovery({
      entryId: "send:pending",
      environmentId: EnvironmentId.make("foreign"),
      target: state.target,
      isCurrent: () => true,
    }),
  ).rejects.toThrow("original thread");
});
