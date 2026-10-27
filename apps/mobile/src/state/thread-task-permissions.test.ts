import {
  AuthOrchestrationOperateScope,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  type ModelSelection,
  type ComposerContextDraft,
  type OrchestrationV2ThreadProjection,
  type ServerConfig,
} from "@t2code/contracts";
import {
  v2Now,
  v2Projection,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import type { PendingThreadRequests } from "@t2code/client-runtime/state/thread-requests";
import { sendApprovalFeedback } from "@t2code/client-runtime/state/thread-requests";
import { AsyncResult, type Atom } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  grantedEnvironments: new Set<string>(),
  connectionState: "connected",
  draft: {
    text: "Keep my draft",
    attachments: [] as DraftComposerImageAttachment[],
    modelSelection: undefined as ModelSelection | undefined,
    contextDraft: undefined as ComposerContextDraft | undefined,
  },
  serverConfig: null as ServerConfig | null,
  projection: null as OrchestrationV2ThreadProjection | null,
  pendingRequests: { approvals: [], userInputs: [] } as PendingThreadRequests,
  enqueue: vi.fn(async () => undefined),
  capture: vi.fn(),
  alert: vi.fn(),
  clearDraft: vi.fn(),
  approve: vi.fn(),
  answer: vi.fn(),
  feedback: vi.fn(),
  updateSettings: vi.fn(),
  question: {
    id: "language",
    header: "Language",
    question: "Which language?",
    options: [{ label: "TypeScript", description: "Use the existing code" }],
    multiSelect: false,
  },
  thread: {
    id: "thread",
    environmentId: "secondary",
    projectId: "project",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    activeProviderThreadId: "provider-thread",
    runtime: null,
    latestRun: null,
  },
}));

vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: <A>(current: A) => ({ current }),
  useMemo: <A>(factory: () => A) => factory(),
  useState: <A>(initial: A | (() => A)) => [
    typeof initial === "function" ? (initial as () => A)() : initial,
    vi.fn(),
  ],
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "uuid" }));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: vi.fn() }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid" }));
vi.mock("./queued-run-edit", () => ({
  useQueuedRunEdit: () => null,
  getQueuedRunEdit: () => null,
}));
vi.mock("./preferences", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return { mobilePreferencesAtom: Atom.make(AsyncResult.success({})) };
});
vi.mock("../components/ui/Dialog", () => ({ alert: state.alert }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@effect/atom-react", async () => {
  const { appAtomRegistry } = await import("./atom-registry");
  return { useAtomValue: <A>(atom: Atom.Atom<A>) => appAtomRegistry.get(atom) };
});
vi.mock("./entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("./session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.grantedEnvironments.has(environmentId),
}));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: state.thread,
    selectedThreadCreation: null,
    selectedEnvironmentRuntime: {
      connectionState: state.connectionState,
      serverConfig: state.serverConfig,
    },
  }),
}));
vi.mock("./use-thread-detail", () => ({
  useSelectedThreadProjection: () =>
    state.projection === null ? null : { projection: state.projection },
  useSelectedThreadVisibleTurnItems: () => [],
  useSelectedThreadPendingRequests: () => state.pendingRequests,
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: <A>(command: A) => command }));
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadDetails: {
      queueWorkflowAtom: () => Atom.make(null),
      checkpointSummariesAtom: () => Atom.make([]),
      pendingRequestsAtom: () => Atom.make(state.pendingRequests),
    },
    threadEnvironment: {
      respondToApproval: state.approve,
      respondToUserInput: state.answer,
      uploadFeedback: state.feedback,
    },
  };
});
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return { dispatchingQueuedMessageIdAtom: Atom.make(null), useThreadOutboxMessages: () => ({}) };
});
vi.mock("./spaces", () => ({ prepareMobileComposerContext: state.capture }));
vi.mock("./thread-outbox", () => ({ enqueueThreadOutboxMessage: state.enqueue }));
vi.mock("./composer-attachment-uploads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerAttachmentUploadsAtom: Atom.make({}),
    composerAttachmentUploadBlockReason: () => null,
    composerAttachmentsStillUploading: () => false,
  };
});
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerDraftsAtom: Atom.make({}),
    composerContextImportsAtom: Atom.make({}),
    getComposerDraftSnapshot: () => state.draft,
    sameComposerDraftState: (left: unknown, right: unknown) => left === right,
    clearComposerDraftContent: state.clearDraft,
    clearComposerDraft: state.clearDraft,
    setComposerDraftText: (_key: string, text: string) => {
      state.draft.text = text;
    },
    updateComposerDraftSettings: state.updateSettings,
    ensureComposerDraftsLoaded: () => {},
    scheduleUnusedComposerAttachmentCleanup: () => {},
    appendComposerDraftAttachments: vi.fn(),
    appendComposerDraftText: vi.fn(),
    mergeComposerDraftContent: vi.fn(),
    removeComposerDraftAttachment: vi.fn(),
    useComposerDraft: () => state.draft,
    useComposerDraftSettings: () => state.draft,
    questionAttachmentDraftsAtom: () => Atom.make({}),
  };
});
vi.mock("../lib/composerImages", () => ({
  convertPastedImagesToAttachments: vi.fn(),
  pasteComposerClipboard: vi.fn(),
  pickComposerFiles: vi.fn(),
  pickComposerMedia: vi.fn(),
}));
vi.mock("../lib/commandMetadata", () => ({
  makeQueuedMessageMetadata: () => ({
    messageId: "message",
    commandId: "command",
    createdAt: "2026-09-05T00:00:00.000Z",
  }),
}));
vi.mock("../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("./use-remote-environment-registry", () => ({ setPendingConnectionError: vi.fn() }));

import { useThreadComposerState } from "./use-thread-composer-state";
import { useSelectedThreadRequests } from "./use-selected-thread-requests";

beforeEach(() => {
  state.grantedEnvironments = new Set(["primary"]);
  state.connectionState = "connected";
  state.draft = {
    text: "Keep my draft",
    attachments: [],
    modelSelection: undefined,
    contextDraft: undefined,
  };
  state.projection = null;
  state.serverConfig = {
    providers: [{ instanceId: "codex", driver: "codex", enabled: true }],
    environment: { capabilities: {} },
  } as unknown as ServerConfig;
  state.pendingRequests = {
    approvals: [
      {
        requestId: RuntimeRequestId.make("approval"),
        requestKind: "command",
        createdAt: "2026-09-05T00:00:00.000Z",
        responseCapability: "live",
      },
    ],
    userInputs: [],
  };
  vi.clearAllMocks();
  state.approve.mockResolvedValue(AsyncResult.success(undefined));
  state.answer.mockResolvedValue(AsyncResult.success(undefined));
  state.feedback.mockResolvedValue(AsyncResult.success({ feedbackId: "feedback" }));
});

describe("mobile task permissions", () => {
  it("consumes an approval reply without queueing a parent message", async () => {
    state.grantedEnvironments.add("secondary");
    const composer = useThreadComposerState();
    const requests = useSelectedThreadRequests();
    const approval = { ...state.pendingRequests.approvals[0]!, supportsFeedback: true };
    const messageId = await composer.onSendMessage(undefined, async (text) =>
      (await sendApprovalFeedback(approval, text, requests.onRespondToApproval))
        ? "responded"
        : false,
    );
    expect(messageId).toBeNull();
    expect(state.approve).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: {
        threadId: "thread",
        requestId: "approval",
        decision: "decline",
        feedback: "Keep my draft",
      },
    });
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.clearDraft).toHaveBeenCalledOnce();
  });

  it("preserves a draft changed during an approval reply and never sends it to the parent", async () => {
    state.grantedEnvironments.add("secondary");
    const composer = useThreadComposerState();
    const beforeDispatch = async () => {
      state.draft = { ...state.draft, text: "New feedback" };
      return "responded" as const;
    };
    expect(await composer.onSendMessage(undefined, beforeDispatch)).toBeNull();
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();
    expect(state.draft.text).toBe("New feedback");
  });

  it("keeps a connected read-only task's draft instead of queueing it with another environment's grant", async () => {
    const composer = useThreadComposerState();
    expect(await composer.onSendMessage()).toBeNull();
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();
    composer.onChangeDraftMessage("Edited locally");
    composer.onUpdateInteractionMode("plan");
    expect(state.draft.text).toBe("Edited locally");
    expect(state.updateSettings).toHaveBeenCalledWith("secondary:thread", {
      interactionMode: "plan",
    });
  });

  it("rechecks a retained send callback before clearing or queueing the draft", async () => {
    state.grantedEnvironments.add("secondary");
    const composer = useThreadComposerState();
    state.grantedEnvironments.delete("secondary");
    expect(await composer.onSendMessage()).toBeNull();
    expect(state.clearDraft).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
    state.grantedEnvironments.add("secondary");
    expect(await composer.onSendMessage()).toBe("message");
    expect(state.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "secondary",
        threadId: "thread",
        text: "Keep my draft",
      }),
      expect.anything(),
    );
  });

  it("rechecks the target environment before an approval response", async () => {
    state.grantedEnvironments.add("secondary");
    const requests = useSelectedThreadRequests();
    state.grantedEnvironments.delete("secondary");
    await requests.onRespondToApproval(RuntimeRequestId.make("approval"), "accept");
    expect(state.approve).not.toHaveBeenCalled();
    state.grantedEnvironments.add("secondary");
    await requests.onRespondToApproval(RuntimeRequestId.make("approval"), "accept");
    expect(state.approve).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { threadId: "thread", requestId: "approval", decision: "accept" },
    });
  });

  it("keeps answer drafts editable after revocation while blocking their submission", async () => {
    state.pendingRequests = {
      approvals: [],
      userInputs: [
        {
          requestId: RuntimeRequestId.make("input"),
          createdAt: "2026-09-05T00:00:00.000Z",
          responseCapability: "live",
          dismissible: false,
          questions: [state.question],
        },
      ],
    };
    const requestId = RuntimeRequestId.make("input");
    useSelectedThreadRequests().onSelectUserInputOption(requestId, state.question, "TypeScript");
    state.grantedEnvironments.add("secondary");
    const requests = useSelectedThreadRequests();
    expect(requests.activePendingUserInputAnswers).toEqual({ language: "TypeScript" });
    state.grantedEnvironments.delete("secondary");
    await requests.onSubmitUserInput();
    expect(state.answer).not.toHaveBeenCalled();
    expect(useSelectedThreadRequests().activePendingUserInputAnswers).toEqual({
      language: "TypeScript",
    });
    state.grantedEnvironments.add("secondary");
    await requests.onSubmitUserInput();
    expect(state.answer).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { threadId: "thread", requestId: "input", answers: { language: "TypeScript" } },
    });
  });
});

describe("mobile handoff preview and submission", () => {
  it("follows project enablement and provider availability for the selected destination", async () => {
    state.grantedEnvironments.add("secondary");
    const instanceId = ProviderInstanceId.make("antigravity");
    const projectId = ProjectId.make(state.thread.projectId);
    const selection = { instanceId, model: "gemini" };
    const provider = {
      instanceId,
      driver: ProviderDriverKind.make("antigravity"),
      enabled: false,
      installed: true,
      auth: { status: "authenticated" as const },
      availability: "available" as "available" | "unavailable",
      models: [{ slug: selection.model }],
    };
    const projectOverride = { enabled: false };
    state.serverConfig = {
      ...state.serverConfig,
      providers: [provider],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: { [instanceId]: { driver: provider.driver, enabled: false } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: projectOverride } },
        },
      },
    } as unknown as ServerConfig;
    state.draft.modelSelection = selection;
    const source = v2Projection.thread.modelSelection;
    state.projection = {
      ...v2Projection,
      runs: [
        {
          id: RunId.make("source-run"),
          threadId: v2Projection.thread.id,
          ordinal: 1,
          providerInstanceId: source.instanceId,
          modelSelection: source,
          providerThreadId: null,
          userMessageId: MessageId.make("source-message"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: v2Now,
          startedAt: v2Now,
          completedAt: v2Now,
          checkpointId: null,
          contextHandoffId: null,
        },
      ],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: v2Projection.thread.id,
          sourceItemId: TurnItemId.make("reply"),
          item: {
            id: TurnItemId.make("reply"),
            threadId: v2Projection.thread.id,
            runId: RunId.make("source-run"),
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            type: "assistant_message",
            messageId: MessageId.make("reply"),
            status: "completed",
            title: null,
            text: "Task started",
            streaming: false,
            startedAt: v2Now,
            completedAt: v2Now,
            updatedAt: v2Now,
          },
        },
      ],
    };

    const disabled = useThreadComposerState();
    expect(disabled.pendingHandoff).toBeNull();
    expect(await disabled.onSendMessage()).toBeNull();
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();

    projectOverride.enabled = true;
    expect(useThreadComposerState().pendingHandoff).toEqual({ from: [source], to: selection });

    provider.availability = "unavailable";
    const unavailable = useThreadComposerState();
    expect(unavailable.pendingHandoff).toBeNull();
    expect(await unavailable.onSendMessage()).toBeNull();
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();

    provider.availability = "available";
    const available = useThreadComposerState();
    expect(available.pendingHandoff).toEqual({ from: [source], to: selection });
    expect(await available.onSendMessage()).toBe("message");
    expect(state.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        modelSelection: selection,
        text: "Keep my draft",
      }),
      expect.anything(),
    );
    expect(state.clearDraft).toHaveBeenCalledTimes(1);
  });
});

it("keeps newer native typing when an earlier send is still being prepared or persisted", async () => {
  state.grantedEnvironments.add("secondary");
  const reply = Promise.withResolvers<undefined>();
  state.enqueue.mockImplementationOnce(() => reply.promise);
  const composer = useThreadComposerState();
  const pending = composer.onSendMessage();
  state.draft = { ...state.draft, text: "Newer typing" };
  reply.resolve(undefined);
  expect(await pending).toBe("message");
  expect(state.clearDraft).not.toHaveBeenCalled();
  expect(state.draft.text).toBe("Newer typing");
});

it("releases a failed send for an explicit retry without clearing newer text or selectors", async () => {
  state.grantedEnvironments.add("secondary");
  state.draft = { ...state.draft, contextDraft: selectorDraft() };
  const reply = Promise.withResolvers<undefined>();
  state.enqueue.mockImplementationOnce(() => reply.promise);
  const composer = useThreadComposerState();
  const pending = composer.onSendMessage();
  expect(await composer.onSendMessage()).toBeNull();
  expect(state.enqueue).toHaveBeenCalledOnce();

  const newerContext: ComposerContextDraft = {
    ...selectorDraft(),
    selectors: selectorDraft().selectors.map((selector) => ({
      ...selector,
      includeChildPages: true,
    })),
  };
  state.draft = { ...state.draft, text: "Newer typing", contextDraft: newerContext };
  reply.reject(new Error("Outbox persistence failed"));
  expect(await pending).toBeNull();
  expect(state.clearDraft).not.toHaveBeenCalled();
  expect(state.draft.text).toBe("Newer typing");
  expect(state.draft.contextDraft).toEqual(newerContext);

  expect(await composer.onSendMessage()).toBe("message");
  expect(state.enqueue).toHaveBeenCalledTimes(2);
  expect(state.enqueue).toHaveBeenLastCalledWith(
    expect.objectContaining({ text: "Newer typing" }),
    expect.objectContaining({ contextDraft: newerContext }),
  );
  expect(state.clearDraft).toHaveBeenCalledOnce();
});

function selectorDraft(): ComposerContextDraft {
  return {
    selectors: [
      {
        version: 1,
        selection: "current",
        kind: "page",
        contextId: "page" as never,
        label: "Page",
        environmentId: "secondary" as never,
        pageId: "source" as never,
        includeChildPages: false,
      },
    ],
    records: [],
  };
}

it("refuses selector-only context as approval feedback without capture, send, or draft clearing", async () => {
  state.grantedEnvironments.add("secondary");
  state.draft = {
    ...state.draft,
    text: "Use [Page](t2-context://v1/page/page)",
    contextDraft: selectorDraft(),
  };
  const composer = useThreadComposerState();
  const requests = useSelectedThreadRequests();
  const approval = { ...state.pendingRequests.approvals[0]!, supportsFeedback: true };
  const flags: boolean[] = [];
  await composer.onSendMessage(undefined, async (text, hasAddedContext) => {
    flags.push(hasAddedContext);
    if (hasAddedContext) return false;
    return (await sendApprovalFeedback(approval, text, requests.onRespondToApproval))
      ? "responded"
      : false;
  });
  expect(flags).toEqual([true]);
  expect(state.approve).not.toHaveBeenCalled();
  expect(state.capture).not.toHaveBeenCalled();
  expect(state.enqueue).not.toHaveBeenCalled();
  expect(state.clearDraft).not.toHaveBeenCalled();
  expect(state.draft.contextDraft).toEqual(selectorDraft());
});

it("retains selectors added while an approval-feedback response is deferred", async () => {
  state.grantedEnvironments.add("secondary");
  const entered = Promise.withResolvers<undefined>();
  const reply = Promise.withResolvers<ReturnType<typeof AsyncResult.success<undefined>>>();
  state.approve.mockImplementationOnce(() => {
    entered.resolve(undefined);
    return reply.promise;
  });
  const composer = useThreadComposerState();
  const requests = useSelectedThreadRequests();
  const approval = { ...state.pendingRequests.approvals[0]!, supportsFeedback: true };
  const pending = composer.onSendMessage(undefined, async (text) =>
    (await sendApprovalFeedback(approval, text, requests.onRespondToApproval))
      ? "responded"
      : false,
  );
  await entered.promise;
  state.draft = { ...state.draft, contextDraft: selectorDraft() };
  reply.resolve(AsyncResult.success(undefined));
  await pending;
  expect(state.approve).toHaveBeenCalledOnce();
  expect(state.capture).not.toHaveBeenCalled();
  expect(state.enqueue).not.toHaveBeenCalled();
  expect(state.clearDraft).not.toHaveBeenCalled();
  expect(state.draft.contextDraft).toEqual(selectorDraft());
});

it.each(["selectors", "records"] as const)(
  "refuses /feedback with added %s while retaining the draft",
  async (kind) => {
    state.grantedEnvironments.add("secondary");
    const selected = selectorDraft();
    const contextDraft: ComposerContextDraft =
      kind === "selectors"
        ? selected
        : {
            selectors: [],
            records: [
              {
                version: 1,
                kind: "page",
                contextId: "page" as never,
                label: "Page",
                title: "Page",
                environmentId: "secondary" as never,
                spaceId: "space" as never,
                pageId: "source" as never,
                snapshot: {
                  version: 1,
                  includeChildPages: false,
                  truncated: false,
                  text: "Copied snapshot",
                  contentHash: `sha256:${"a".repeat(64)}`,
                  sources: [
                    {
                      environmentId: "secondary" as never,
                      spaceId: "space" as never,
                      pageId: "source" as never,
                      revision: 1,
                      blockIds: [],
                    },
                  ],
                },
              },
            ],
          };
    state.draft = {
      ...state.draft,
      text: "/feedback Inspect [Page](t2-context://v1/page/page)",
      contextDraft,
    };
    const draft = structuredClone(state.draft);
    const approvalGuard = vi.fn(async () => "responded" as const);
    expect(await useThreadComposerState().onSendMessage(undefined, approvalGuard)).toBeNull();
    expect(state.feedback).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();
    expect(state.capture).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(approvalGuard).not.toHaveBeenCalled();
    expect(state.alert).toHaveBeenCalledOnce();
    expect(state.draft).toEqual(draft);
  },
);
