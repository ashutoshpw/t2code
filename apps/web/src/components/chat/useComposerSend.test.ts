import { expect, it, vi } from "vite-plus/test";
import type { ChatMessage } from "../../types";
import type { ComposerThreadDraftState } from "../../composerDraftStore";
import type { ChatComposerHandle } from "./ChatComposer";
import { ComposerContextId, EnvironmentId, ProviderDriverKind, ThreadId } from "@t2code/contracts";
import { SpacePageId, SpaceId } from "@t2code/contracts/spaces";
import { scopeThreadRef, scopedThreadKey } from "@t2code/client-runtime/environment";

const state = vi.hoisted(() => ({
  connected: true,
  dispatch: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
  navigate: vi.fn(),
  toasts: [] as Array<{
    actionProps?: { children: string; onClick: () => void };
    timeout?: number;
  }>,
  prepare: vi.fn(),
}));
vi.mock("react", async () => ({
  ...(await vi.importActual<typeof import("react")>("react")),
  useRef: <A>(current: A) => ({ current }),
  useLayoutEffect: () => {},
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettingsHydrated: () => true,
  useEnvironmentSettings: () => false,
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.dispatch,
}));
vi.mock("./useMultipleModelSend", () => ({ useMultipleModelSend: () => vi.fn() }));
vi.mock("./useProposedPlanSend", () => ({ usePlanFollowUpSend: () => vi.fn() }));
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
import { makeThreadFixture } from "../../test-fixtures";
import { useComposerSend } from "./useComposerSend";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("removes a refused send's optimistic row and recovers its original snapshot without overwriting newer typing", async () => {
  state.connected = true;
  state.dispatch.mockClear();
  state.toasts.length = 0;
  const environmentId = EnvironmentId.make("failed-send-env");
  const thread = makeThreadFixture({ environmentId, id: ThreadId.make("failed-send-thread") });
  const target = scopeThreadRef(environmentId, thread.id);
  const route = scopedThreadKey(target);
  const store = useComposerDraftStore.getState();
  store.clearComposerContent(target);
  const originalPrompt = "Use [Page](t2-context://v1/page/p)";
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
    records: [],
  });
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
    currentRouteThreadKeyRef: { current: route },
    draftId: null,
    draftThread: null,
    activeThread: thread,
    activeThreadKey: route,
    activeThreadBranch: null,
    activeProject: { id: thread.projectId, environmentId, workspaceRoot: "/isolated-project" },
    activeProjectDefaultModelSelection: null,
    activeProposedPlan: null,
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
    showPlanFollowUpPrompt: false,
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
  const pending = useComposerSend(input).onSend();
  await settingsEntered.promise;
  expect(optimistic).toHaveLength(1);
  expect(optimistic[0]?.context?.records[0]).toMatchObject({
    snapshot: { text: "Captured before settings" },
  });
  expect(store.getComposerDraft(target)?.prompt ?? "").toBe("");
  store.setPrompt(target, "Newer typing");
  promptRef.current = "Newer typing";
  state.connected = false;
  settings.resolve({ _tag: "Success", value: undefined });
  await pending;
  expect(state.dispatch).not.toHaveBeenCalled();
  expect(optimistic).toEqual([]);
  expect(store.getComposerDraft(target)?.prompt).toBe("Newer typing");
  const recovery = state.toasts.find((toast) => toast.actionProps?.children === "Restore prompt");
  expect(recovery).toBeDefined();
  expect(recovery?.timeout).toBe(0);
  recovery!.actionProps!.onClick();
  expect(store.getComposerDraft(target)?.prompt).toBe("Newer typing");
  store.clearComposerContent(target);
  recovery!.actionProps!.onClick();
  const restored: ComposerThreadDraftState | null = store.getComposerDraft(target);
  expect(restored?.prompt).toBe(originalPrompt);
  expect(restored?.contextDraft).toEqual(original.contextDraft);
  expect(promptRef.current).toBe(originalPrompt);
  store.clearComposerContent(target);
});
