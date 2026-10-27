import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  ComposerContextId,
  OrchestrationDispatchCommandError,
  type ModelSelection,
} from "@t2code/contracts";
import { SpacePageId } from "@t2code/contracts/spaces";
import { scopeProjectRef } from "@t2code/client-runtime/environment";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

const state = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    reject: false,
    rejectAccepted: false,
    afterWrite: undefined as (() => void) | undefined,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (
        storage.reject ||
        (storage.rejectAccepted &&
          JSON.parse(value).state.entries.some(
            (entry: { recovery?: { fanout?: { attempts: Array<{ outcome: string }> } } }) =>
              entry.recovery?.fanout?.attempts.some((attempt) => attempt.outcome === "accepted"),
          ))
      )
        throw new Error("Quota exceeded");
      values.set(key, value);
      storage.afterWrite?.();
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  vi.stubGlobal("localStorage", storage);
  return {
    next: 0,
    storage,
    values,
    operate: true,
    session: {} as object | null,
    dispatch: vi.fn(),
    toasts: [] as Array<{
      title?: string;
      description?: string;
      actionProps?: { children: string; onClick: () => unknown };
    }>,
    navigate: vi.fn(),
  };
});
vi.mock("react", async () => ({
  ...(await vi.importActual<typeof import("react")>("react")),
  useRef: <A>(current: A) => ({ current }),
  useLayoutEffect: () => {},
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.dispatch,
}));
vi.mock("../../state/session", async () => ({
  ...(await vi.importActual<typeof import("../../state/session")>("../../state/session")),
  readEnvironmentScope: () => state.operate,
  readPreparedConnection: () => state.session,
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: <A>(value: A) => value,
  toastManager: {
    add: (value: (typeof state.toasts)[number]) => {
      state.toasts.push(value);
      return "toast";
    },
    close: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock("../../composerDraftStore", async () => {
  const actual = await vi.importActual<typeof import("../../composerDraftStore")>(
    "../../composerDraftStore",
  );
  const store = actual.useComposerDraftStore;
  return {
    ...actual,
    useComposerDraftStore: Object.assign(
      (select: (value: ReturnType<typeof store.getState>) => unknown) => select(store.getState()),
      store,
    ),
  };
});

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { PROMPT_STASH_STORAGE_KEY, usePromptStashStore } from "../../promptStashStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { snapshotComposerSend } from "../ChatView.logic";
import { draftFanoutSelectionsAtom, draftSendState } from "./chatViewSend";
import { useMultipleModelSend } from "./useMultipleModelSend";
import { restoreComposerSendRecovery } from "../../lib/composerSendRecovery";
import type { ChatComposerHandle } from "./ChatComposer";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const accepted = () => AsyncResult.success(undefined);
const refused = () =>
  AsyncResult.failure(
    Cause.fail(
      new OrchestrationDispatchCommandError({
        message: "Thread was not created",
        bootstrapThreadDisposition: "not-created",
      }),
    ),
  );
const unknown = () => AsyncResult.failure(Cause.die(new Error("Connection closed before reply")));

function setup(count = 3) {
  state.storage.reject = false;
  state.storage.rejectAccepted = false;
  state.storage.afterWrite = undefined;
  state.values.clear();
  state.operate = true;
  state.session = {};
  state.toasts.length = 0;
  state.dispatch.mockReset();
  usePromptStashStore.setState({ entries: [], activeRecoveryIds: [] });
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  const environmentId = EnvironmentId.make("fanout-env");
  const projectId = ProjectId.make("fanout-project");
  const threadId = ThreadId.make("fanout-origin");
  const draftId = DraftId.make("fanout-draft");
  const routeKey = `draft:fanout-draft-${state.next++}`;
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, {
    threadId,
    branch: "main",
    runtimeMode: "full-access",
    startFromOrigin: false,
  });
  const prompt = "  Inspect [Page](t2-context://v1/page/page)  ";
  store.setPrompt(draftId, prompt);
  store.setContextDraft(draftId, {
    selectors: [
      {
        version: 1,
        selection: "current",
        kind: "page",
        contextId: ComposerContextId.make("page"),
        label: "Page",
        environmentId,
        pageId: SpacePageId.make("page"),
        includeChildPages: false,
      },
    ],
    records: [],
  });
  const selections: ModelSelection[] = Array.from({ length: count }, (_, index) => ({
    instanceId: ProviderInstanceId.make("codex"),
    model: `model-${index}`,
    options: [{ id: "effort", value: "high" }],
  }));
  const atom = draftFanoutSelectionsAtom(routeKey);
  appAtomRegistry.set(atom, selections);
  const contents = { ...store.getComposerDraft(draftId)! };
  const sendState = draftSendState(routeKey);
  sendState.sendInFlight.current = true;
  const entered = deferred<undefined>();
  const replies = selections.map(() =>
    deferred<
      ReturnType<typeof accepted> | ReturnType<typeof refused> | ReturnType<typeof unknown>
    >(),
  );
  state.dispatch.mockImplementation((request: { input: { modelSelection: ModelSelection } }) => {
    const index = selections.findIndex(
      (selection) => selection.model === request.input.modelSelection.model,
    );
    entered.resolve(undefined);
    return replies[index]!.promise;
  });
  const promptRef = { current: prompt };
  const resetLocalDispatch = vi.fn();
  const setThreadError = vi.fn();
  const handle = { resetCursorState: vi.fn() } as unknown as ChatComposerHandle;
  const run = useMultipleModelSend({
    environmentId,
    routeThreadKey: routeKey,
    currentRouteThreadKeyRef: { current: routeKey },
    draftId,
    composerDraftTarget: draftId,
    composerRef: { current: handle },
    promptRef,
    runtimeMode: "full-access",
    startFromOrigin: false,
    resetLocalDispatch,
    setThreadError,
    beginLocalDispatch: vi.fn(),
  });
  const invoke = () => {
    const current = store.getComposerDraft(draftId)!;
    const signature = JSON.stringify(current);
    return run({
      threadId,
      project: { id: projectId, environmentId, workspaceRoot: "/isolated" },
      branch: "main",
      selections,
      targets: selections.map((selection) => ({
        selection,
        text: current.prompt.trim(),
        interactionMode: "default" as const,
      })),
      sendSnapshot: snapshotComposerSend({
        ...current,
        sendableTerminalContexts: current.terminalContexts,
      }),
      recoveryContents: current,
      createdAt: "2026-10-27T00:00:00Z",
      attachmentsPromise: Promise.resolve([]),
      usesAttachmentUploads: false,
      readFileBlockReason: () => null,
      buildOutgoingMessageContext: () => undefined,
      assertContextCurrent: () => {},
      isCurrentDraft: () => JSON.stringify(store.getComposerDraft(draftId)) === signature,
      isCurrentSend: () => true,
    });
  };
  return {
    environmentId,
    projectId,
    threadId,
    draftId,
    routeKey,
    store,
    prompt,
    selections,
    atom,
    contents,
    promptRef,
    invoke,
    entered,
    replies,
    resetLocalDispatch,
    setThreadError,
  };
}

it("persists original fanout intent before dispatch and retains partial outcomes across typing and reload", async () => {
  const f = setup();
  const pending = f.invoke();
  await f.entered.promise;
  try {
    const raw = JSON.parse(state.storage.getItem(PROMPT_STASH_STORAGE_KEY)!);
    const entry = raw.state.entries[0];
    expect(entry.prompt).toBe(f.prompt);
    expect(entry.recovery.context.contextDraft).toEqual(f.contents.contextDraft);
    expect(
      entry.recovery.fanout.attempts.map(
        (attempt: { selection: ModelSelection }) => attempt.selection,
      ),
    ).toEqual(f.selections);
    for (const [request] of state.dispatch.mock.calls) {
      const attempt = entry.recovery.fanout.attempts.find(
        (value: { threadId: string }) => value.threadId === request.input.threadId,
      );
      expect(attempt).toMatchObject({
        messageId: request.input.message.messageId,
        outcome: "uncertain",
      });
    }
    f.store.setPrompt(f.draftId, "Newer typing");
    const newer = [{ instanceId: ProviderInstanceId.make("codex"), model: "newer-model" }];
    appAtomRegistry.set(f.atom, newer);
    f.replies[0]!.resolve(accepted());
    f.replies[1]!.resolve(refused());
    f.replies[2]!.resolve(unknown());
    await pending;
    expect(f.store.getComposerDraft(f.draftId)?.prompt).toBe("Newer typing");
    expect(appAtomRegistry.get(f.atom)).toEqual(newer);
    expect(
      usePromptStashStore
        .getState()
        .entries[0]?.recovery?.fanout?.attempts.map((attempt) => attempt.outcome),
    ).toEqual(["accepted", "failed", "uncertain"]);
    vi.resetModules();
    const reloaded = await import("../../promptStashStore");
    expect(
      reloaded.usePromptStashStore
        .getState()
        .entries[0]?.recovery?.fanout?.attempts.map((attempt) => attempt.outcome),
    ).toEqual(["accepted", "failed", "uncertain"]);
  } finally {
    for (const reply of f.replies) reply.resolve(unknown());
    await pending;
  }
});

it.each(["full", "quota"] as const)(
  "refuses fanout without clear, dispatch or eviction when recovery storage is %s",
  async (reason) => {
    const f = setup();
    if (reason === "full")
      for (let index = 0; index < 20; index += 1)
        usePromptStashStore.getState().stashEntry({
          id: `saved-${index}`,
          createdAt: "2026-10-27T00:00:00Z",
          prompt: "Saved",
          attachments: [],
          droppedImageNames: [],
        });
    state.storage.reject = reason === "quota";
    for (const reply of f.replies) reply.resolve(accepted());
    await f.invoke();
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(f.store.getComposerDraft(f.draftId)).toEqual(f.contents);
    expect(usePromptStashStore.getState().entries).toHaveLength(reason === "full" ? 20 : 0);
    state.storage.reject = false;
  },
);

it.each(["operate", "connection", "typing"] as const)(
  "keeps the draft when %s changes during asynchronous recovery encoding",
  async (change) => {
    const f = setup();
    const reading = deferred<undefined>();
    const allowed = deferred<undefined>();
    const previous = globalThis.FileReader;
    vi.stubGlobal(
      "FileReader",
      class extends EventTarget {
        result: string | null = null;
        readAsDataURL(blob: Blob) {
          reading.resolve(undefined);
          void allowed.promise.then(async () => {
            this.result = `data:${blob.type};base64,${btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())))}`;
            this.dispatchEvent(new Event("load"));
          });
        }
      },
    );
    const file = new File(["original"], "original.png", { type: "image/png" });
    f.store.addImages(f.draftId, [
      {
        type: "image",
        id: "image",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
        previewUrl: "blob:original",
      },
    ]);
    const before = f.store.getComposerDraft(f.draftId)!;
    const pending = f.invoke();
    await reading.promise;
    if (change === "operate") state.operate = false;
    else if (change === "connection") state.session = {};
    else {
      f.store.setPrompt(f.draftId, "Newer typing");
      f.promptRef.current = "Newer typing";
    }
    allowed.resolve(undefined);
    try {
      await pending;
      expect(state.dispatch).not.toHaveBeenCalled();
      expect(f.store.getComposerDraft(f.draftId)?.prompt).toBe(
        change === "typing" ? "Newer typing" : before.prompt,
      );
      expect(f.store.getComposerDraft(f.draftId)?.images).toEqual(before.images);
      expect(f.store.getComposerDraft(f.draftId)?.contextDraft).toEqual(before.contextDraft);
      expect(usePromptStashStore.getState().entries).toEqual([]);
    } finally {
      vi.stubGlobal("FileReader", previous);
    }
  },
);

it("checks permission before each dispatch and retains definite unsent models after partial acceptance", async () => {
  const f = setup();
  state.dispatch.mockImplementation(() => {
    state.operate = false;
    return Promise.resolve(accepted());
  });
  await f.invoke();
  expect(state.dispatch).toHaveBeenCalledTimes(1);
  expect(
    usePromptStashStore
      .getState()
      .entries[0]?.recovery?.fanout?.attempts.map((attempt) => attempt.outcome),
  ).toEqual(["accepted", "not-sent", "not-sent"]);
});

it("restores only definite failures, and a deliberate new retry never repeats an accepted or uncertain model", async () => {
  const f = setup();
  const pending = f.invoke();
  await f.entered.promise;
  f.replies[0]!.resolve(accepted());
  f.replies[1]!.resolve(refused());
  f.replies[2]!.resolve(unknown());
  await pending;
  const entry = usePromptStashStore.getState().entries[0]!;
  await restoreComposerSendRecovery({
    entryId: entry.id,
    environmentId: f.environmentId,
    target: f.draftId,
    isCurrent: () => true,
  });
  expect(appAtomRegistry.get(f.atom)).toEqual([f.selections[1]]);
  expect(f.store.getComposerDraft(f.draftId)?.fanoutRetry?.selections).toEqual([f.selections[1]]);
  expect(f.store.getComposerDraft(f.draftId)?.prompt).toBe(f.prompt);
  expect(state.dispatch).toHaveBeenCalledTimes(3);
  const retrySelection = f.selections[1]!;
  f.selections.splice(0, f.selections.length, retrySelection);
  state.dispatch.mockImplementation(async () => accepted());
  await f.invoke();
  expect(state.dispatch).toHaveBeenCalledTimes(4);
  expect(state.dispatch.mock.calls[3]?.[0].input.modelSelection).toEqual(retrySelection);
  expect(usePromptStashStore.getState().entries.map((saved) => saved.id)).toEqual([entry.id]);
});

it("keeps unknown outcomes across reload and requires explicit selection to restore an uncertain model", async () => {
  const f = setup(2);
  const pending = f.invoke();
  await f.entered.promise;
  f.replies.forEach((reply) => reply.resolve(unknown()));
  await pending;
  const entry = usePromptStashStore.getState().entries[0]!;
  await expect(
    restoreComposerSendRecovery({
      entryId: entry.id,
      environmentId: f.environmentId,
      target: f.draftId,
      isCurrent: () => true,
    }),
  ).rejects.toThrow("Check uncertain threads");
  await expect(
    restoreComposerSendRecovery({
      entryId: entry.id,
      environmentId: f.environmentId,
      target: f.draftId,
      isCurrent: () => true,
      fanoutAttemptIds: [entry.recovery!.fanout!.attempts[0]!.id],
    }),
  ).rejects.toThrow("Check uncertain threads");
  await restoreComposerSendRecovery({
    entryId: entry.id,
    environmentId: f.environmentId,
    target: f.draftId,
    isCurrent: () => true,
    fanoutAttemptIds: [entry.recovery!.fanout!.attempts[0]!.id],
    allowUncertain: true,
  });
  expect(f.store.getComposerDraft(f.draftId)?.fanoutRetry).toMatchObject({
    selections: [f.selections[0]],
    uncertain: true,
  });
  expect(state.dispatch).toHaveBeenCalledTimes(2);
  expect(
    usePromptStashStore
      .getState()
      .entries[0]?.recovery?.fanout?.attempts.map((attempt) => attempt.outcome),
  ).toEqual(["uncertain", "uncertain"]);
});

it("keeps the write-ahead uncertainty after a server acknowledgement cannot be persisted", async () => {
  const f = setup(2);
  const pending = f.invoke();
  await f.entered.promise;
  state.storage.rejectAccepted = true;
  f.replies[0]!.resolve(accepted());
  f.replies[1]!.resolve(unknown());
  await pending;
  expect(
    usePromptStashStore
      .getState()
      .entries[0]?.recovery?.fanout?.attempts.map((attempt) => attempt.outcome),
  ).toEqual(["accepted", "uncertain"]);
  vi.resetModules();
  const reloaded = await import("../../promptStashStore");
  expect(
    reloaded.usePromptStashStore
      .getState()
      .entries[0]?.recovery?.fanout?.attempts.map((attempt) => attempt.outcome),
  ).toEqual(["uncertain", "uncertain"]);
  expect(state.toasts.some((toast) => toast.description?.includes("could not be saved"))).toBe(
    true,
  );
});

it("does not dispatch unless its possible-send marker is durably saved", async () => {
  const f = setup(2);
  state.storage.afterWrite = () => {
    state.storage.afterWrite = undefined;
    state.storage.reject = true;
  };
  await f.invoke();
  expect(state.dispatch).not.toHaveBeenCalled();
  expect(
    usePromptStashStore
      .getState()
      .entries[0]?.recovery?.fanout?.attempts.map((attempt) => attempt.outcome),
  ).toEqual(["not-sent", "not-sent"]);
  expect(f.store.getComposerDraft(f.draftId)?.prompt ?? "").toBe("");
  state.storage.reject = false;
});

it("refuses oversized fanout metadata before clearing or dispatching", async () => {
  const f = setup(17);
  await f.invoke();
  expect(state.dispatch).not.toHaveBeenCalled();
  expect(f.store.getComposerDraft(f.draftId)).toEqual(f.contents);
  expect(usePromptStashStore.getState().entries).toEqual([]);
});

it("rehydrates a failed-only restoration and persists the exact retry selection guard", async () => {
  vi.useFakeTimers();
  try {
    const f = setup(2);
    const pending = f.invoke();
    await f.entered.promise;
    f.replies[0]!.resolve(accepted());
    f.replies[1]!.resolve(refused());
    await pending;
    await vi.advanceTimersByTimeAsync(300);
    vi.resetModules();
    const drafts = await import("../../composerDraftStore");
    const stash = await import("../../promptStashStore");
    const recovery = await import("../../lib/composerSendRecovery");
    const registry = await import("../../rpc/atomRegistry");
    const fanout = await import("../../lib/composerFanout");
    const entry = stash.usePromptStashStore.getState().entries[0]!;
    await recovery.restoreComposerSendRecovery({
      entryId: entry.id,
      environmentId: f.environmentId,
      target: f.draftId,
      isCurrent: () => true,
    });
    expect(registry.appAtomRegistry.get(fanout.draftFanoutSelectionsAtom(f.routeKey))).toEqual([
      f.selections[1],
    ]);
    expect(
      drafts.useComposerDraftStore.getState().getComposerDraft(f.draftId)?.fanoutRetry?.selections,
    ).toEqual([f.selections[1]]);
    await vi.advanceTimersByTimeAsync(300);
    vi.resetModules();
    const rehydrated = await import("../../composerDraftStore");
    expect(
      rehydrated.useComposerDraftStore.getState().getComposerDraft(f.draftId)?.fanoutRetry
        ?.selections,
    ).toEqual([f.selections[1]]);
    expect(state.dispatch).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("refuses changed options on a restored retry instead of silently changing its model intent", async () => {
  const f = setup(2);
  const pending = f.invoke();
  await f.entered.promise;
  f.replies[0]!.resolve(accepted());
  f.replies[1]!.resolve(refused());
  await pending;
  const entry = usePromptStashStore.getState().entries[0]!;
  await restoreComposerSendRecovery({
    entryId: entry.id,
    environmentId: f.environmentId,
    target: f.draftId,
    isCurrent: () => true,
  });
  f.selections.splice(0, f.selections.length, {
    ...f.selections[1]!,
    options: [{ id: "effort", value: "low" }],
  });
  const before = f.store.getComposerDraft(f.draftId);
  await f.invoke();
  expect(state.dispatch).toHaveBeenCalledTimes(2);
  expect(f.store.getComposerDraft(f.draftId)).toBe(before);
  expect(f.setThreadError.mock.calls.at(-1)?.[1]).toContain("recovered model selections");
});

it("reconciles an older successful fanout without deleting a newer action or typing", async () => {
  const f = setup(2);
  const first = f.invoke();
  await f.entered.promise;
  const firstId = usePromptStashStore.getState().entries[0]!.id;
  f.store.setPrompt(f.draftId, "Second action");
  f.promptRef.current = "Second action";
  const secondEntered = deferred<undefined>();
  const laterReplies = f.selections.map(() => deferred<ReturnType<typeof unknown>>());
  state.dispatch.mockImplementation((request: { input: { modelSelection: ModelSelection } }) => {
    secondEntered.resolve(undefined);
    return laterReplies[
      f.selections.findIndex((selection) => selection.model === request.input.modelSelection.model)
    ]!.promise;
  });
  const second = f.invoke();
  await secondEntered.promise;
  const secondId = usePromptStashStore.getState().entries.find((entry) => entry.id !== firstId)!.id;
  f.store.setPrompt(f.draftId, "Third typing");
  f.replies.forEach((reply) => reply.resolve(accepted()));
  await first;
  expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([secondId]);
  expect(f.store.getComposerDraft(f.draftId)?.prompt).toBe("Third typing");
  laterReplies.forEach((reply) => reply.resolve(unknown()));
  await second;
  expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([secondId]);
  expect(f.store.getComposerDraft(f.draftId)?.prompt).toBe("Third typing");
});

it("requires recovery review before replaying the original prompt after an interrupted fanout", async () => {
  const f = setup();
  const pending = f.invoke();
  await f.entered.promise;
  f.replies[0]!.resolve(accepted());
  f.replies[1]!.resolve(refused());
  f.replies[2]!.resolve(unknown());
  await pending;
  f.store.setPrompt(f.draftId, f.prompt);
  f.store.setContextDraft(f.draftId, f.contents.contextDraft);
  const before = f.store.getComposerDraft(f.draftId);
  state.dispatch.mockImplementation(async () => accepted());
  await f.invoke();
  expect(state.dispatch).toHaveBeenCalledTimes(3);
  expect(f.store.getComposerDraft(f.draftId)).toBe(before);
  expect(f.setThreadError.mock.calls.at(-1)?.[1]).toContain("fanout recovery");
});
