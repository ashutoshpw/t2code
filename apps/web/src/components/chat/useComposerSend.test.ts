import { expect, it, vi } from "vite-plus/test";
import type { ChatMessage } from "../../types";
import type { ComposerThreadDraftState } from "../../composerDraftStore";
import type { ChatComposerHandle } from "./ChatComposer";
import { ComposerContextId, EnvironmentId, ProviderDriverKind, ThreadId } from "@t2code/contracts";
import { SpacePageId, SpaceId } from "@t2code/contracts/spaces";
import { scopeThreadRef, scopedThreadKey } from "@t2code/client-runtime/environment";

const state = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storage.reject) throw new Error("Storage quota exceeded");
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    reject: false,
  };
  vi.stubGlobal("localStorage", storage);
  return {
    storage,
    connected: true,
    planMode: false,
    dispatch: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
    navigate: vi.fn(),
    toasts: [] as Array<{
      title?: string;
      actionProps?: { children: string; onClick: () => void | Promise<void> };
      timeout?: number;
    }>,
    prepare: vi.fn(),
  };
});
vi.mock("react", async () => ({
  ...(await vi.importActual<typeof import("react")>("react")),
  useRef: <A>(current: A) => ({ current }),
  useLayoutEffect: () => {},
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettingsHydrated: () => true,
  useEnvironmentSettings: () => state.planMode,
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.dispatch,
}));
vi.mock("./useMultipleModelSend", () => ({ useMultipleModelSend: () => vi.fn() }));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: <A>(value: A) => value,
  toastManager: {
    add: (toast: (typeof state.toasts)[number]) => {
      state.toasts.push(toast);
      return "recovery";
    },
    update: vi.fn(),
    close: vi.fn(),
  },
}));
vi.mock("../../state/session", async () => ({
  ...(await vi.importActual<typeof import("../../state/session")>("../../state/session")),
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/server", async () => {
  const actual = await vi.importActual<typeof import("../../state/server")>("../../state/server");
  const { Atom } = await import("effect/reactivity");
  return { ...actual, environmentServerConfigsAtom: Atom.make(new Map()) };
});
vi.mock("../../state/presentation", async () => {
  const actual = await vi.importActual<typeof import("../../state/presentation")>(
    "../../state/presentation",
  );
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsAtom: Atom.make(new Map()),
    },
  };
});
vi.mock("../../composerDraftStore", async () => {
  const actual = await vi.importActual<typeof import("../../composerDraftStore")>(
    "../../composerDraftStore",
  );
  const store = actual.useComposerDraftStore;
  return {
    ...actual,
    useComposerDraftStore: Object.assign(
      (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()),
      store,
    ),
  };
});
vi.mock("../../lib/prepareComposerSendContext", async () => ({
  ...(await vi.importActual<typeof import("../../lib/prepareComposerSendContext")>(
    "../../lib/prepareComposerSendContext",
  )),
  prepareComposerSendContext: state.prepare,
}));

import { useComposerDraftStore } from "../../composerDraftStore";
import { PROMPT_STASH_STORAGE_KEY, usePromptStashStore } from "../../promptStashStore";
import { makeThreadFixture } from "../../test-fixtures";
import { useComposerSend } from "./useComposerSend";
import { draftSendState } from "./chatViewSend";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function verifyFailedSnapshotRecovery(
  path: "normal send" | "plan follow-up",
  restoreFromOtherRoute: boolean,
  admission: "ok" | "full" | "quota" = "ok",
  succeeds = false,
  editWhileSavingImage = false,
) {
  state.storage.reject = false;
  usePromptStashStore.setState({ entries: [], activeRecoveryIds: [] });
  state.storage.removeItem(PROMPT_STASH_STORAGE_KEY);
  state.planMode = path === "plan follow-up";
  state.connected = true;
  state.dispatch.mockClear();
  state.prepare.mockClear();
  state.toasts.length = 0;
  const environmentId = EnvironmentId.make("failed-send-env");
  const thread = makeThreadFixture({ environmentId, id: ThreadId.make("failed-send-thread") });
  const target = scopeThreadRef(environmentId, thread.id);
  const route = scopedThreadKey(target);
  draftSendState(route).sendInFlight.current = false;
  const store = useComposerDraftStore.getState();
  store.clearComposerContent(target);
  const originalPrompt =
    "  Use [Page](t2-context://v1/page/p) and [Copied](t2-context://v1/page/copied)  ";
  const copied = {
    version: 1 as const,
    kind: "page" as const,
    contextId: ComposerContextId.make("copied"),
    label: "Copied",
    title: "Copied",
    environmentId,
    spaceId: SpaceId.make("space"),
    pageId: SpacePageId.make("copied-page"),
    snapshot: {
      version: 1 as const,
      includeChildPages: false,
      truncated: false,
      text: "Original copied snapshot",
      contentHash: `sha256:${"a".repeat(64)}`,
      sources: [
        {
          environmentId,
          spaceId: SpaceId.make("space"),
          pageId: SpacePageId.make("copied-page"),
          revision: 1,
          blockIds: [],
        },
      ],
    },
  };
  store.setPrompt(target, originalPrompt);
  store.setContextDraft(target, {
    selectors: [
      {
        version: 1,
        selection: "current",
        kind: "page",
        contextId: ComposerContextId.make("p"),
        label: "Page",
        environmentId,
        pageId: SpacePageId.make("page"),
        includeChildPages: false,
      },
    ],
    records: [copied],
  });
  const imageReadStarted = deferred<undefined>();
  const imageReadAllowed = deferred<undefined>();
  const previousFileReader = globalThis.FileReader;
  if (editWhileSavingImage) {
    const image = new File(["image bytes"], "image.png", { type: "image/png" });
    store.addImages(target, [
      {
        type: "image",
        id: "pending-image",
        name: image.name,
        mimeType: image.type,
        sizeBytes: image.size,
        file: image,
        previewUrl: "blob:pending-image",
      },
    ]);
    vi.stubGlobal(
      "FileReader",
      class extends EventTarget {
        result: string | null = null;
        readAsDataURL(blob: Blob) {
          imageReadStarted.resolve(undefined);
          void imageReadAllowed.promise.then(async () => {
            this.result = `data:${blob.type};base64,${btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())))}`;
            this.dispatchEvent(new Event("load"));
          });
        }
      },
    );
  }
  const original = structuredClone(store.getComposerDraft(target)!);
  state.prepare.mockResolvedValue({
    context: {
      version: 1,
      records: [
        {
          version: 1,
          kind: "page",
          contextId: ComposerContextId.make("p"),
          label: "Page",
          title: "Page",
          environmentId,
          spaceId: SpaceId.make("space"),
          pageId: SpacePageId.make("page"),
          snapshot: {
            version: 1,
            includeChildPages: false,
            truncated: false,
            text: "Captured before settings",
            contentHash: `sha256:${"a".repeat(64)}`,
            sources: [
              {
                environmentId,
                spaceId: SpaceId.make("space"),
                pageId: SpacePageId.make("page"),
                revision: 1,
                blockIds: [],
              },
            ],
          },
        },
      ],
    },
    assertCurrent: () => {
      if (!state.connected) throw new Error("Spaces access changed before sending.");
    },
  });
  const settings = deferred<{ _tag: "Success"; value: undefined }>();
  const settingsEntered = deferred<undefined>();
  const promptRef = { current: originalPrompt };
  const currentRouteThreadKeyRef = { current: route as string | null };
  let optimistic: ChatMessage[] = [];
  const noop = vi.fn();
  const handle = {
    getSendContext: () => ({
      ...store.getComposerDraft(target)!,
      providerAvailable: true,
      multipleModelSelections: null,
      selectedProvider: ProviderDriverKind.make("codex"),
      selectedModel: "gpt-5.4",
      selectedProviderModels: [],
      selectedModelSelection: thread.modelSelection,
      selectedPromptEffort: null,
      selectedModelOptionsForDispatch: undefined,
      answeringPendingUserInput: false,
      interactionMode: "default",
      interactionModeEnabled: true,
      shownPendingApprovalIds: [],
    }),
    validateProviderInput: () => true,
    resetCursorState: noop,
  } as unknown as ChatComposerHandle;
  const input = {
    environmentId,
    routeThreadKey: route,
    currentRouteThreadKeyRef,
    draftId: null,
    draftThread: null,
    activeThread: thread,
    activeThreadKey: route,
    activeThreadBranch: null,
    activeProject: { id: thread.projectId, environmentId, workspaceRoot: "/isolated-project" },
    activeProjectDefaultModelSelection: null,
    activeProposedPlan: state.planMode
      ? { id: "proposed-plan", planMarkdown: "A proposed implementation" }
      : null,
    activeMessageCount: 1,
    isServerThread: true,
    isLocalDraftThread: false,
    isGitRepo: false,
    phase: "ready",
    runtimeMode: "full-access",
    sendEnvMode: "local",
    startFromOrigin: false,
    localCheckoutBranchMismatch: null,
    logicalProjectEnvironments: [],
    providerInstanceEntries: [],
    composerRef: { current: handle },
    composerDraftTarget: target,
    promptRef,
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    feedbackUploadsInFlightRef: { current: new Set() },
    queuedRunEdit: { isEditing: false },
    isConnecting: false,
    isRevertingCheckpoint: false,
    threadDetailLoading: false,
    activeEnvironmentUnavailable: false,
    isSendBusy: false,
    sendQueuesBehindSetup: false,
    isDraftHeroState: false,
    panelAnimationsActive: false,
    panelAnimationDurationMs: 0,
    keepFullHistory: true,
    resumeCompactionTokens: null,
    showPlanFollowUpPrompt: state.planMode,
    usageLimitsKey: null,
    usageLimitsOffered: false,
    openUsageLimits: noop,
    clearUsageLimitsFor: noop,
    needsLoadBalancing: false,
    loadBalancing: { pending: false },
    readPendingEnvironmentChange: () => null,
    pendingApprovals: [],
    respondingRequestIds: [],
    activePendingProgress: null,
    onAdvanceActivePendingUserInput: noop,
    onRespondToApproval: noop,
    beginLocalDispatch: noop,
    resetLocalDispatch: noop,
    beginWorktreeSetup: noop,
    captureDraftHeroComposerRect: noop,
    setDockedDraftHeroThreadKey: noop,
    setSetupQueueSendThreadKey: noop,
    setOptimisticUserMessages: (update: (previous: ChatMessage[]) => ChatMessage[]) => {
      optimistic = update(optimistic);
    },
    setFeedbackSubmissionsByThreadKey: noop,
    setThreadError: noop,
    setKeepFullHistory: noop,
    anchorNewTurn: noop,
    acknowledgeActiveThreadWoke: noop,
    handleInteractionModeChange: noop,
    handleNewThreadInActiveProject: noop,
    persistThreadSettingsForNextTurn: () => {
      settingsEntered.resolve(undefined);
      return settings.promise;
    },
  } as unknown as Parameters<typeof useComposerSend>[0];
  if (admission === "full") {
    for (let index = 0; index < 20; index += 1) {
      usePromptStashStore.getState().stashEntry({
        id: `existing-${index}`,
        createdAt: "2026-10-27T00:00:00Z",
        prompt: "Saved",
        attachments: [],
        droppedImageNames: [],
      });
    }
  }
  state.storage.reject = admission === "quota";
  if (admission !== "ok") settings.resolve({ _tag: "Success", value: undefined });
  const pending = useComposerSend(input).onSend();
  if (editWhileSavingImage) {
    await imageReadStarted.promise;
    store.setPrompt(target, "Typed while saving recovery");
    promptRef.current = "Typed while saving recovery";
    imageReadAllowed.resolve(undefined);
    await pending;
    expect(store.getComposerDraft(target)?.prompt).toBe("Typed while saving recovery");
    expect(store.getComposerDraft(target)?.images.map((image) => image.id)).toEqual([
      "pending-image",
    ]);
    expect(store.getComposerDraft(target)?.contextDraft).toEqual(original.contextDraft);
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(optimistic).toEqual([]);
    expect(usePromptStashStore.getState().entries).toEqual([]);
    vi.stubGlobal("FileReader", previousFileReader);
    store.clearComposerContent(target);
    return;
  }
  if (admission !== "ok") {
    await pending;
    expect(store.getComposerDraft(target)).toEqual(original);
    expect(optimistic).toEqual([]);
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.toasts.some((toast) => toast.title === "Message was not sent")).toBe(true);
    expect(usePromptStashStore.getState().entries).toHaveLength(admission === "full" ? 20 : 0);
    state.storage.reject = false;
    return;
  }
  await settingsEntered.promise;
  expect(optimistic).toHaveLength(1);
  expect(optimistic[0]?.context?.records[0]).toMatchObject({
    snapshot: { text: "Captured before settings" },
  });
  expect(store.getComposerDraft(target)?.prompt ?? "").toBe("");
  const reserved = usePromptStashStore.getState().entries[0];
  expect(reserved?.prompt).toBe(originalPrompt);
  expect(reserved?.recovery).toMatchObject({
    environmentId,
    threadId: thread.id,
    context: { contextDraft: original.contextDraft },
  });
  const persisted = JSON.parse(state.storage.getItem(PROMPT_STASH_STORAGE_KEY)!);
  expect(persisted.state.entries[0]).toEqual(reserved);
  // A later independent stash must survive this send's reconciliation.
  usePromptStashStore.getState().stashEntry({
    id: "newer-entry",
    createdAt: "2026-10-27T00:00:00Z",
    prompt: "Another saved draft",
    attachments: [],
    droppedImageNames: [],
  });
  store.setPrompt(target, "Newer typing");
  promptRef.current = "Newer typing";
  state.connected = succeeds;
  settings.resolve({ _tag: "Success", value: undefined });
  await pending;
  if (succeeds) {
    expect(state.dispatch).toHaveBeenCalledTimes(1);
    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
      "newer-entry",
    ]);
    expect(store.getComposerDraft(target)?.prompt).toBe("Newer typing");
    return;
  }
  expect(state.dispatch).not.toHaveBeenCalled();
  expect(optimistic).toEqual([]);
  expect(store.getComposerDraft(target)?.prompt).toBe("Newer typing");
  const recovery = state.toasts.find((toast) => toast.actionProps?.children === "Restore prompt");
  expect(recovery).toBeDefined();
  expect(recovery?.timeout).toBe(0);
  await recovery!.actionProps!.onClick();
  expect(store.getComposerDraft(target)?.prompt).toBe("Newer typing");
  store.clearComposerContent(target);
  if (restoreFromOtherRoute) {
    currentRouteThreadKeyRef.current = "other-route";
    promptRef.current = "Other thread typing";
  }
  await recovery!.actionProps!.onClick();
  const restored: ComposerThreadDraftState | null = store.getComposerDraft(target);
  expect(restored?.prompt).toBe(originalPrompt);
  expect(restored?.contextDraft).toEqual(original.contextDraft);
  expect(promptRef.current).toBe(restoreFromOtherRoute ? "Other thread typing" : originalPrompt);
  expect(usePromptStashStore.getState().entries).toContainEqual(reserved);
  if (path === "normal send" && !restoreFromOtherRoute) {
    vi.resetModules();
    const reloadedStash = await import("../../promptStashStore");
    const reloadedDrafts = await import("../../composerDraftStore");
    const { restoreComposerSendRecovery } = await import("../../lib/composerSendRecovery");
    expect(reloadedStash.usePromptStashStore.getState().entries).toContainEqual(reserved);
    reloadedDrafts.useComposerDraftStore.getState().clearComposerContent(target);
    await restoreComposerSendRecovery({
      entryId: reserved!.id,
      environmentId,
      target,
      isCurrent: () => true,
    });
    const recovered = reloadedDrafts.useComposerDraftStore.getState().getComposerDraft(target);
    expect(recovered?.prompt).toBe(originalPrompt);
    expect(recovered?.contextDraft).toEqual(original.contextDraft);
    // Debounced composer writes must not remove the durable recovery copy.
    expect(reloadedStash.usePromptStashStore.getState().entries).toContainEqual(reserved);
  }
  if (!restoreFromOtherRoute) {
    state.connected = true;
    await useComposerSend(input).onSend();
    expect(state.prepare).toHaveBeenCalledTimes(2);
    expect(state.prepare.mock.calls[1]?.[0].contextDraft).toEqual(original.contextDraft);
    expect(state.dispatch).toHaveBeenCalledTimes(1);
    expect(usePromptStashStore.getState().entries).toContainEqual(reserved);
  }
  store.clearComposerContent(target);
}

it.each([
  ["normal send", false],
  ["normal send", true],
  ["plan follow-up", false],
  ["plan follow-up", true],
] as const)(
  "recovers a refused %s without overwriting typing (other route: %s)",
  verifyFailedSnapshotRecovery,
);

it.each(["normal send", "plan follow-up"] as const)(
  "refuses %s without clearing when recovery is full",
  async (path) => {
    await verifyFailedSnapshotRecovery(path, false, "full");
  },
);
it.each(["normal send", "plan follow-up"] as const)(
  "refuses %s without clearing when durable storage rejects the write",
  async (path) => {
    await verifyFailedSnapshotRecovery(path, false, "quota");
  },
);
it.each(["normal send", "plan follow-up"] as const)(
  "cleans only the successful %s recovery",
  async (path) => {
    await verifyFailedSnapshotRecovery(path, false, "ok", true);
  },
);

it("retains newer typing and the original image when the draft changes during recovery encoding", async () => {
  await verifyFailedSnapshotRecovery("normal send", false, "ok", false, true);
});
