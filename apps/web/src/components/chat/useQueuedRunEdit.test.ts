import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";
import { ComposerContextId, EnvironmentId, MessageId, RunId, ThreadId } from "@t2code/contracts";
import { SpaceId, SpacePageId } from "@t2code/contracts/spaces";
import { scopeThreadRef } from "@t2code/client-runtime/environment";
import type { ThreadStructure } from "@t2code/client-runtime/state/shell";

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  runs: null as Atom.Writable<
    ReadonlyArray<{ id: RunId; status: string }> | null,
    ReadonlyArray<{ id: RunId; status: string }> | null
  > | null,
  command: vi.fn(async () => AsyncResult.success(undefined)),
  query: vi.fn<() => Promise<AsyncResult.AsyncResult<{ relativeUrl: string }, unknown>>>(async () =>
    AsyncResult.success({ relativeUrl: "/original-image" }),
  ),
  rpc: vi.fn(),
  upload: vi.fn(),
  notifications: [] as Array<{
    title?: string;
    description?: string;
    actionProps?: { onClick: () => unknown };
    data?: { secondaryActionProps?: { onClick: () => unknown } };
  }>,
  notified: undefined as (() => void) | undefined,
  connection: { httpBaseUrl: "https://queue.test/" } as { httpBaseUrl: string } | null,
  operate: true,
  allowDiscard: false,
  stashHandlers: [] as Array<(event: KeyboardEvent) => void>,
}));
vi.mock("zustand", async () => {
  const actual = await vi.importActual<typeof import("zustand")>("zustand");
  const wrap = <T>(initializer: import("zustand").StateCreator<T>) => {
    const store = actual.create(initializer);
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store);
  };
  return {
    ...actual,
    create: <T>(initializer?: import("zustand").StateCreator<T>) =>
      initializer ? wrap(initializer) : wrap<T>,
  };
});
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const hooks = {
    useRef: <A>(current: A) => ({ current }),
    useState: <A>(initial: A | (() => A)) => [
      typeof initial === "function" ? (initial as () => A)() : initial,
      () => {},
    ],
    useEffect: (run: () => unknown) => {
      run();
    },
    useLayoutEffect: () => {},
    use: () => false,
    useCallback: <A>(fn: A) => fn,
    useMemo: <A>(fn: () => A) => fn(),
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
    useDebugValue: () => {},
  };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock("../../shortcuts/dispatcher", () => ({
  registerCommands: (commands: Record<string, (event: KeyboardEvent) => void>) => {
    state.stashHandlers.push(commands["composer.stash"]!);
    return () => {};
  },
}));
vi.mock("../../commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));
vi.mock("@effect/atom-react", async () => ({
  ...(await vi.importActual<typeof import("@effect/atom-react")>("@effect/atom-react")),
  useAtomValue: (atom: Atom.Atom<unknown>) => state.registry!.get(atom),
}));
vi.mock("../../hooks/useStableCallback", () => ({ useStableCallback: <A>(fn: A) => fn }));
vi.mock("../../assets/assetUrls", () => ({ useAssetUrls: () => [] }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.command }));
vi.mock("../../state/session", async () => ({
  ...(await vi.importActual<typeof import("../../state/session")>("../../state/session")),
  readPreparedConnection: () => state.connection,
  readEnvironmentScope: () => state.operate,
}));
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    threadEnvironment: { editQueuedRun: {}, snapshotAtom: () => Atom.make(null) },
    environmentThreadDetails: {
      statusAtom: () => Atom.make("ready"),
      quietThreadAtom: () => Atom.make((get) => ({ projection: { runs: get(state.runs!) } })),
    },
    environmentThreadShells: { threadShellAtom: () => Atom.make(null) },
  };
});
vi.mock("../ui/toast", () => ({
  stackedThreadToast: <A>(value: A) => value,
  toastManager: {
    add: (notice: (typeof state.notifications)[number]) => {
      state.notifications.push(notice);
      if (
        notice.title === "Queued edit recovery saved" ||
        notice.title === "Queued edit kept open for recovery" ||
        notice.title === "Queued edit recovery did not finish"
      )
        state.notified?.();
      return "notice";
    },
  },
}));
vi.mock("@t2code/client-runtime/state/runtime", async () => ({
  ...(await vi.importActual<typeof import("@t2code/client-runtime/state/runtime")>(
    "@t2code/client-runtime/state/runtime",
  )),
  executeAtomQuery: (...args: unknown[]) => state.query(...(args as [])),
  runAtomCommand: (...args: unknown[]) => state.rpc(...args),
}));
vi.mock("../../state/server", async () => {
  const actual = await vi.importActual<typeof import("../../state/server")>("../../state/server");
  const { Atom } = await import("effect/reactivity");
  return { ...actual, environmentServerConfigsAtom: Atom.make(new Map()).pipe(Atom.keepAlive) };
});
vi.mock("../../state/assets", () => ({
  assetEnvironment: { createUrl: (target: unknown) => target },
}));
vi.mock("../../state/attachments", () => ({
  attachmentEnvironment: { createUploadUrl: "upload", remove: "remove" },
}));
vi.mock("../../connection/catalog", async () => {
  const actual = await vi.importActual<typeof import("../../connection/catalog")>(
    "../../connection/catalog",
  );
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const connected = Atom.make(AsyncResult.success({ phase: "connected" })).pipe(Atom.keepAlive);
  return { environmentCatalog: { ...actual.environmentCatalog, stateAtom: () => connected } };
});
vi.mock("../../lib/uploadBytes", () => ({ uploadBytes: (input: unknown) => state.upload(input) }));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: async () => state.allowDiscard } }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function setup(
  attachments: ReadonlyArray<import("@t2code/contracts").ChatAttachment> = [],
  durable = true,
  previousContext?: import("@t2code/contracts").OrchestrationMessageContext,
) {
  vi.resetModules();
  state.notifications.length = 0;
  state.stashHandlers.length = 0;
  state.notified = undefined;
  state.command.mockReset();
  state.command.mockImplementation(async () => AsyncResult.success(undefined));
  state.query.mockReset();
  state.query.mockImplementation(async () =>
    AsyncResult.success({ relativeUrl: "/original-image" }),
  );
  state.rpc.mockReset();
  state.rpc.mockImplementation(async (_registry, command) =>
    AsyncResult.success(
      command === "upload"
        ? { attachmentId: "local-file-upload", relativeUrl: "/upload", expiresAt: 1 }
        : undefined,
    ),
  );
  state.upload.mockReset();
  state.connection = { httpBaseUrl: "https://queue.test/" };
  state.operate = true;
  state.allowDiscard = false;
  const values = new Map<string, string>();
  const storage = {
    reject: false,
    afterWrite: undefined as ((key: string) => void) | undefined,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storage.reject && key === "t2code:prompt-stash:v2") throw new Error("Quota");
      values.set(key, value);
      storage.afterWrite?.(key);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  vi.stubGlobal("localStorage", durable ? storage : undefined);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { requestAnimationFrame: () => 0 }));
  const registry = await import("../../rpc/atomRegistry");
  state.registry = registry.appAtomRegistry;
  const drafts = await import("../../composerDraftStore");
  const stash = await import("../../promptStashStore");
  const config = await import("../../state/server");
  const environmentIdForConfig = EnvironmentId.make("queue-env");
  registry.appAtomRegistry.set(
    config.environmentServerConfigsAtom as Atom.Writable<
      ReadonlyMap<EnvironmentId, import("@t2code/contracts").ServerConfig>,
      ReadonlyMap<EnvironmentId, import("@t2code/contracts").ServerConfig>
    >,
    new Map([
      [
        environmentIdForConfig,
        {
          environment: {
            capabilities: {
              attachmentUploads: true,
              fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
              inlineMessageContext: true,
              spaces: { version: 2, features: { contextCapture: true } },
            },
          },
        } as unknown as import("@t2code/contracts").ServerConfig,
      ],
    ]),
  );
  const hook = await import("./useQueuedRunEdit");
  const environmentId = EnvironmentId.make("queue-env");
  const threadId = ThreadId.make("queue-thread");
  const routeThreadRef = scopeThreadRef(environmentId, threadId);
  const runId = RunId.make("queue-run");
  state.runs = Atom.make<ReadonlyArray<{ id: RunId; status: string }> | null>([
    { id: runId, status: "queued" },
  ]).pipe(Atom.keepAlive);
  const promptRef = { current: "" };
  const read = () =>
    hook.useQueuedRunEdit({
      environmentId,
      routeThreadRef,
      threadDraftTarget: routeThreadRef,
      activeThreadId: threadId,
      serverProjection: {
        runs: [{ id: runId, status: "queued" }],
        messages: previousContext
          ? [{ id: MessageId.make("queue-message"), context: previousContext }]
          : [],
      } as unknown as ThreadStructure,
      promptRef,
      composerRef: { current: null },
    });
  read().beginEdit({
    runId,
    messageId: MessageId.make("queue-message"),
    text: "original",
    attachments,
  });
  const editTarget = read().draftTarget;
  const store = drafts.useComposerDraftStore.getState();
  const prompt = "  Changed [Page](t2-context://v1/page/p)  ";
  store.setPrompt(editTarget, prompt);
  store.setContextDraft(editTarget, {
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
    records:
      previousContext?.records.filter(
        (record) => record.kind === "page" || record.kind === "block",
      ) ?? [],
  });
  store.setPrompt(routeThreadRef, "Separate composer");
  const done = deferred<undefined>();
  state.notified = () => done.resolve(undefined);
  const leave = () => state.registry!.set(state.runs!, [{ id: runId, status: "running" }]);
  return {
    environmentId,
    threadId,
    runId,
    ...drafts,
    ...stash,
    store,
    read,
    leave,
    done,
    editTarget,
    routeThreadRef,
    prompt,
    storage,
    values,
  };
}

it("retains the real edit owner until exact queued-edit recovery is durably saved, without replacing a separate composer", async () => {
  const f = await setup();
  const original = f.store.getComposerDraft(f.editTarget)!;
  f.leave();
  expect(f.store.getComposerDraft(f.editTarget)).toBe(original);
  await f.done.promise;
  expect(f.store.getComposerDraft(f.routeThreadRef)?.prompt).toBe("Separate composer");
  const entry = f.usePromptStashStore.getState().entries[0]!;
  expect(entry.prompt).toBe(f.prompt);
  expect(entry.recovery?.context.contextDraft).toEqual(original.contextDraft);
  expect(f.read().isEditing).toBe(false);
  expect(state.command).not.toHaveBeenCalled();
  vi.resetModules();
  const reloaded = await import("../../promptStashStore");
  expect(reloaded.usePromptStashStore).not.toBe(f.usePromptStashStore);
  expect(reloaded.usePromptStashStore.getState().entries[0]?.prompt).toBe(f.prompt);
});

it.each(["full", "quota"] as const)(
  "retains a recoverable edit on %s admission failure and can explicitly retry later",
  async (reason) => {
    const f = await setup();
    if (reason === "full")
      for (let i = 0; i < 20; i++)
        f.usePromptStashStore.getState().stashEntry({
          id: `old-${i}`,
          createdAt: "2026-10-27",
          prompt: "Saved",
          attachments: [],
          droppedImageNames: [],
        });
    f.storage.reject = reason === "quota";
    const original = f.store.getComposerDraft(f.editTarget)!;
    f.leave();
    expect(f.store.getComposerDraft(f.editTarget)).toBe(original);
    await f.done.promise;
    expect(f.read().isEditing).toBe(true);
    expect(f.store.getComposerDraft(f.routeThreadRef)?.prompt).toBe("Separate composer");
    expect(state.command).not.toHaveBeenCalled();
    f.storage.reject = false;
    if (reason === "full") f.usePromptStashStore.getState().takeEntry("old-0");
    const retry = state.notifications.at(-1)?.actionProps?.onClick;
    expect(retry).toBeTypeOf("function");
    await retry!();
    expect(f.usePromptStashStore.getState().entries[0]?.prompt).toBe(f.prompt);
    expect(f.read().isEditing).toBe(false);
    expect(state.command).not.toHaveBeenCalled();
  },
);

it("persists original queued image bytes and typed handles before releasing the edit, then restores after fresh reload", async () => {
  const original = {
    type: "image" as const,
    id: "queued-image",
    name: "original.png",
    mimeType: "image/png",
    sizeBytes: 4,
  };
  const f = await setup([original]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([65, 65, 65, 65]))),
  );
  vi.stubGlobal(
    "FileReader",
    class extends EventTarget {
      result: string | null = null;
      readAsDataURL(blob: Blob) {
        void blob.arrayBuffer().then((bytes) => {
          this.result = `data:${blob.type};base64,${btoa(String.fromCharCode(...new Uint8Array(bytes)))}`;
          this.dispatchEvent(new Event("load"));
        });
      }
    },
  );
  f.leave();
  await f.done.promise;
  const entry = f.usePromptStashStore.getState().entries[0]!;
  expect(entry.attachments).toMatchObject([
    { id: "queued-image", dataUrl: "data:image/png;base64,QUFBQQ==" },
  ]);
  expect(entry.recovery?.queuedEdit?.attachments).toEqual([original]);
  vi.resetModules();
  const drafts = await import("../../composerDraftStore");
  const stash = await import("../../promptStashStore");
  const recovery = await import("../../lib/composerSendRecovery");
  expect(stash.usePromptStashStore).not.toBe(f.usePromptStashStore);
  drafts.useComposerDraftStore.getState().clearComposerContent(f.routeThreadRef);
  await recovery.restoreComposerSendRecovery({
    entryId: entry.id,
    environmentId: f.environmentId,
    target: f.routeThreadRef,
    isCurrent: () => true,
  });
  const restored = drafts.useComposerDraftStore.getState().getComposerDraft(f.routeThreadRef)!;
  expect(restored.prompt).toBe(f.prompt);
  expect(restored.contextDraft).toEqual(entry.recovery?.context.contextDraft);
  expect(await restored.images[0]!.file.text()).toBe("AAAA");
  expect(state.query).toHaveBeenCalledTimes(1);
  expect(state.command).not.toHaveBeenCalled();
});

it("keeps async local image bytes and newer thread typing owned until encoding finishes", async () => {
  const f = await setup();
  const reading = deferred<undefined>();
  const allow = deferred<undefined>();
  vi.stubGlobal(
    "FileReader",
    class extends EventTarget {
      result: string | null = null;
      readAsDataURL(blob: Blob) {
        reading.resolve(undefined);
        void allow.promise.then(async () => {
          this.result = `data:${blob.type};base64,${btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())))}`;
          this.dispatchEvent(new Event("load"));
        });
      }
    },
  );
  const file = new File(["original image"], "original.png", { type: "image/png" });
  f.store.addImages(f.editTarget, [
    {
      id: "new-image",
      type: "image",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
      previewUrl: "blob:original",
    },
  ]);
  f.leave();
  await reading.promise;
  expect(f.store.getComposerDraft(f.editTarget)?.images[0]?.file).toBe(file);
  expect(f.read().isSaving).toBe(true);
  f.store.setPrompt(f.routeThreadRef, "Newer typing");
  f.read().beginEdit({
    runId: RunId.make("other"),
    messageId: MessageId.make("other-message"),
    text: "Other",
    attachments: [],
  });
  expect(f.store.getComposerDraft(f.editTarget)?.prompt).toBe(f.prompt);
  allow.resolve(undefined);
  await f.done.promise;
  expect(f.usePromptStashStore.getState().entries[0]?.attachments[0]?.dataUrl).toBe(
    "data:image/png;base64,b3JpZ2luYWwgaW1hZ2U=",
  );
  expect(f.store.getComposerDraft(f.routeThreadRef)?.prompt).toBe("Newer typing");
  expect(state.command).not.toHaveBeenCalled();
});

it.each(["image-limit", "unavailable-storage"] as const)(
  "retains the source and warns before unload when recovery fails from %s",
  async (reason) => {
    const f = await setup([], reason !== "unavailable-storage");
    if (reason === "image-limit") {
      const file = new File([new Uint8Array(2_025_001)], "large.png", { type: "image/png" });
      f.store.addImages(f.editTarget, [
        {
          id: "large",
          type: "image",
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
          previewUrl: "blob:large",
        },
      ]);
    }
    const original = f.store.getComposerDraft(f.editTarget)!;
    f.leave();
    await f.done.promise;
    expect(f.read().isEditing).toBe(true);
    expect(f.store.getComposerDraft(f.editTarget)).toBe(original);
    expect(f.usePromptStashStore.getState().entries).toEqual([]);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    expect(state.command).not.toHaveBeenCalled();
  },
);

it.each(["success", "grant-withdrawn", "upload-failed"] as const)(
  "retains an unsaved original File through real upload lifecycle %s",
  async (outcome) => {
    const f = await setup([
      {
        id: "queued-file",
        type: "file",
        name: "same.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      },
    ]);
    const file = new File(["PDF original"], "same.pdf", { type: "application/pdf" });
    f.store.addFiles(f.editTarget, [
      {
        id: "new-file",
        type: "file",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      },
    ]);
    const uploaded = deferred<void>();
    const started = deferred<undefined>();
    state.upload.mockImplementation((input: { file: File }) => {
      expect(input.file).toBe(file);
      started.resolve(undefined);
      return { done: uploaded.promise, abort: vi.fn() };
    });
    f.leave();
    await Promise.race([
      started.promise,
      f.done.promise.then(() => {
        throw new Error(JSON.stringify(state.notifications));
      }),
    ]);
    expect(await f.store.getComposerDraft(f.editTarget)!.files[0]!.file!.text()).toBe(
      "PDF original",
    );
    f.store.setPrompt(f.routeThreadRef, "Typed while uploading");
    if (outcome === "grant-withdrawn") state.operate = false;
    if (outcome === "upload-failed") uploaded.reject(new Error("Upload failed"));
    else uploaded.resolve();
    await f.done.promise;
    if (outcome !== "success") {
      expect(f.read().isEditing).toBe(true);
      expect(f.store.getComposerDraft(f.editTarget)?.files[0]?.file).toBe(file);
      expect(f.usePromptStashStore.getState().entries).toEqual([]);
      expect(state.command).not.toHaveBeenCalled();
      return;
    }
    const entry = f.usePromptStashStore.getState().entries[0]!;
    expect(entry.files).toMatchObject([
      { id: "new-file", attachmentId: "local-file-upload", name: "same.pdf" },
    ]);
    expect(entry.recovery?.queuedEdit?.attachments).toEqual([
      {
        id: "queued-file",
        type: "file",
        name: "same.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      },
    ]);
    expect(f.store.getComposerDraft(f.routeThreadRef)?.prompt).toBe("Typed while uploading");
    expect(f.read().isEditing).toBe(false);
    expect(state.command).not.toHaveBeenCalled();
    const ownership = await import("../../lib/attachmentUploadQueue");
    expect(
      ownership.releasePersistedAttachmentUpload({
        id: "other-local",
        environmentId: f.environmentId,
        attachmentId: "queued-file",
      }),
    ).toBe(false);
    expect(state.rpc.mock.calls.filter(([, command]) => command === "remove")).toEqual([]);
  },
);

it("keeps newer edit contents when recovery encoding completes stale", async () => {
  const f = await setup();
  const reading = deferred<undefined>();
  const allow = deferred<undefined>();
  vi.stubGlobal(
    "FileReader",
    class extends EventTarget {
      result: string | null = null;
      readAsDataURL(blob: Blob) {
        reading.resolve(undefined);
        void allow.promise.then(async () => {
          this.result = `data:${blob.type};base64,${btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())))}`;
          this.dispatchEvent(new Event("load"));
        });
      }
    },
  );
  const file = new File(["original"], "a.png", { type: "image/png" });
  f.store.addImages(f.editTarget, [
    {
      id: "image",
      type: "image",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
      previewUrl: "blob:original",
    },
  ]);
  f.leave();
  await reading.promise;
  f.store.setPrompt(f.editTarget, "Newer edit contents");
  allow.resolve(undefined);
  await f.done.promise;
  expect(f.store.getComposerDraft(f.editTarget)?.prompt).toBe("Newer edit contents");
  expect(f.read().isEditing).toBe(true);
  expect(f.usePromptStashStore.getState().entries).toEqual([]);
});

it("keeps an uncertain queued save as recovery after the run leaves, without another update", async () => {
  const f = await setup();
  f.store.setPrompt(f.editTarget, "Changed plain message");
  f.store.setContextDraft(f.editTarget, { selectors: [], records: [] });
  const invoked = deferred<undefined>();
  const reply = deferred<never>();
  state.command.mockImplementation(() => {
    invoked.resolve(undefined);
    return reply.promise;
  });
  const draft = f.store.getComposerDraft(f.editTarget)!;
  const saving = f.read().saveEdit(draft, vi.fn());
  await invoked.promise;
  f.leave();
  expect(f.read().isSaving).toBe(true);
  reply.reject(new Error("Reply lost"));
  await saving;
  await f.done.promise;
  expect(state.command).toHaveBeenCalledTimes(1);
  expect(f.usePromptStashStore.getState().entries[0]?.recovery?.queuedEdit?.saveOutcome).toBe(
    "uncertain",
  );
  expect(f.read().isEditing).toBe(false);
  expect(state.notifications.at(-1)?.description).toContain("may have committed");
});

it("retains exact completed records, selectors, opaque context and terminal text across queued recovery reload", async () => {
  const environmentId = EnvironmentId.make("queue-env");
  const record = {
    version: 1 as const,
    kind: "page" as const,
    contextId: ComposerContextId.make("old"),
    label: "Stored",
    title: "Stored",
    environmentId,
    spaceId: SpaceId.make("space"),
    pageId: SpacePageId.make("old-page"),
    snapshot: {
      version: 1 as const,
      includeChildPages: false,
      truncated: false,
      text: "Immutable old bytes",
      contentHash: `sha256:${"a".repeat(64)}`,
      sources: [
        {
          environmentId,
          spaceId: SpaceId.make("space"),
          pageId: SpacePageId.make("old-page"),
          revision: 1,
          blockIds: [],
        },
      ],
    },
  };
  const opaque = {
    version: 1 as const,
    kind: "future",
    contextId: ComposerContextId.make("opaque"),
    label: "Future",
    payload: { "unsafe<tag>": "preserved", nested: [1, 2] },
  };
  const f = await setup([], true, { version: 1, records: [record, opaque] });
  f.store.setTerminalContexts(f.editTarget, [
    {
      id: "terminal",
      threadId: f.threadId,
      createdAt: "2026-10-27",
      terminalId: "shell",
      terminalLabel: "Shell",
      lineStart: 1,
      lineEnd: 1,
      text: "Original terminal bytes",
    },
  ]);
  const exact = f.store.getComposerDraft(f.editTarget)!;
  f.leave();
  await f.done.promise;
  vi.resetModules();
  const stash = await import("../../promptStashStore");
  const entry = stash.usePromptStashStore.getState().entries[0]!;
  expect(entry.prompt).toBe(exact.prompt);
  expect(entry.recovery?.context.contextDraft?.selectors).toEqual(exact.contextDraft?.selectors);
  expect(entry.recovery?.context.contextDraft?.records).toEqual([opaque, record]);
  expect(entry.recovery?.context.terminalContexts).toEqual(exact.terminalContexts);
  expect(state.command).not.toHaveBeenCalled();
  expect(state.rpc).not.toHaveBeenCalled();
});

it("does not clear a newer source after its old generation is durably copied", async () => {
  const f = await setup();
  f.storage.afterWrite = (key) => {
    if (key !== f.PROMPT_STASH_STORAGE_KEY) return;
    f.storage.afterWrite = undefined;
    f.store.setPrompt(f.editTarget, "Newer edit after persistence");
    f.store.setPrompt(f.routeThreadRef, "Newer main composer");
  };
  f.leave();
  await f.done.promise;
  expect(f.usePromptStashStore.getState().entries[0]?.prompt).toBe(f.prompt);
  expect(f.usePromptStashStore.getState().activeRecoveryIds).toEqual([]);
  expect(f.store.getComposerDraft(f.editTarget)?.prompt).toBe("Newer edit after persistence");
  expect(f.store.getComposerDraft(f.routeThreadRef)?.prompt).toBe("Newer main composer");
  expect(f.read().isEditing).toBe(true);
});

it.each(["failed", "captured"] as const)(
  "keeps the queued edit when capture is %s after its run leaves, without a late update",
  async (captureOutcome) => {
    const f = await setup();
    const entered = deferred<undefined>();
    const record = {
      version: 1 as const,
      kind: "page" as const,
      contextId: ComposerContextId.make("p"),
      label: "Page",
      title: "Page",
      environmentId: f.environmentId,
      spaceId: SpaceId.make("space"),
      pageId: SpacePageId.make("page"),
      snapshot: {
        version: 1 as const,
        includeChildPages: false,
        truncated: false,
        text: "Current capture",
        contentHash: "",
        sources: [
          {
            environmentId: f.environmentId,
            spaceId: SpaceId.make("space"),
            pageId: SpacePageId.make("page"),
            revision: 1,
            blockIds: [],
          },
        ],
      },
    };
    const { serializeSpaceContextSnapshotForHash } =
      await import("@t2code/shared/composerContextReferences");
    record.snapshot.contentHash = `sha256:${Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(serializeSpaceContextSnapshotForHash(record)),
        ),
      ),
    )
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
    const captured = AsyncResult.success({ status: "captured" as const, record });
    const reply = deferred<ReturnType<typeof AsyncResult.failure> | typeof captured>();
    state.rpc.mockImplementation(async (_registry, _command, target: { input: unknown }) => {
      if (target.input === undefined) return AsyncResult.success(() => state.connection);
      entered.resolve(undefined);
      return reply.promise;
    });
    const errors = vi.fn();
    const draft = f.store.getComposerDraft(f.editTarget)!;
    const saving = f.read().saveEdit(draft, errors);
    await entered.promise;
    f.leave();
    reply.resolve(
      captureOutcome === "failed"
        ? AsyncResult.failure(Cause.die(new Error("Capture unavailable")))
        : captured,
    );
    await saving;
    expect(state.command).not.toHaveBeenCalled();
    await f.done.promise;
    expect(errors.mock.calls.at(-1)?.[1]).toContain(
      captureOutcome === "failed" ? "capture" : "left the queue",
    );
    expect(f.usePromptStashStore.getState().entries[0]?.prompt).toBe(f.prompt);
    expect(f.usePromptStashStore.getState().entries[0]?.recovery?.queuedEdit?.saveOutcome).toBe(
      "not-sent",
    );
  },
);

it.each(["read-denied", "short-body", "failed-response", "unavailable-image"] as const)(
  "retains queued attachment handles without claiming a saved copy when original-image admission fails: %s",
  async (failure) => {
    const f = await setup([
      { id: "queued-image", type: "image", name: "a.png", mimeType: "image/png", sizeBytes: 4 },
    ]);
    const queryStarted = deferred<undefined>();
    const reply = deferred<Awaited<ReturnType<typeof state.query>>>();
    state.query.mockImplementation(() => {
      queryStarted.resolve(undefined);
      return reply.promise;
    });
    const fetchImage = vi.fn(async () =>
      failure === "failed-response"
        ? new Response(null, { status: 503 })
        : new Response(new Uint8Array([65])),
    );
    vi.stubGlobal("fetch", fetchImage);
    f.leave();
    await queryStarted.promise;
    if (failure === "read-denied") state.operate = false;
    reply.resolve(
      failure === "unavailable-image"
        ? AsyncResult.failure(Cause.die(new Error("Image unavailable")))
        : AsyncResult.success({ relativeUrl: "/image" }),
    );
    await f.done.promise;
    expect(f.read().isEditing).toBe(true);
    expect(f.read().editingAttachments?.[0]?.attachment.id).toBe("queued-image");
    expect(f.store.getComposerDraft(f.editTarget)?.prompt).toBe(f.prompt);
    expect(f.usePromptStashStore.getState().entries).toEqual([]);
    expect(state.notifications.at(-1)?.description).not.toMatch(
      /\b(?:remains?|stays?)\b.*\bstash\b/i,
    );
    if (failure === "read-denied" || failure === "unavailable-image")
      expect(fetchImage).not.toHaveBeenCalled();
    else expect(fetchImage).toHaveBeenCalledOnce();
  },
);

it("allows an explicit confirmed discard of a blocked edit without changing its queue or separate composer", async () => {
  const f = await setup();
  f.storage.reject = true;
  f.leave();
  await f.done.promise;
  await f.read().cancelEdit();
  expect(f.read().isEditing).toBe(true);
  expect(f.store.getComposerDraft(f.editTarget)?.prompt).toBe(f.prompt);
  state.allowDiscard = true;
  await f.read().cancelEdit();
  expect(f.read().isEditing).toBe(false);
  expect(f.store.getComposerDraft(f.routeThreadRef)?.prompt).toBe("Separate composer");
  expect(state.command).not.toHaveBeenCalled();
});

async function bindStash(f: Awaited<ReturnType<typeof setup>>, target = f.editTarget) {
  const stash = await import("./useComposerStash");
  const promptRef = { current: f.store.getComposerDraft(target)?.prompt ?? "" };
  const hook = stash.useComposerStash({
    environmentId: f.environmentId,
    composerDraftTarget: target,
    promptRef,
    readAttachmentDraft: () => ({
      images: f.store.getComposerDraft(target)?.images ?? [],
      files: f.store.getComposerDraft(target)?.files ?? [],
    }),
    readTerminalContexts: () => f.store.getComposerDraft(target)?.terminalContexts ?? [],
    routeThreadRef: f.routeThreadRef,
    projectSelectionRequired: false,
    pendingUserInputs: [],
    activePendingProgress: null,
    prompt: promptRef.current,
    composerMenuOpen: false,
    isComposerCollapsedMobile: false,
    composerPreviewAnnotations: [],
    composerReviewComments: [],
    composerThreadContexts: [],
    attachmentTargetKey: f.composerTargetKey(target),
    isComposerDraftTargetOpen: () => true,
    composerEditorRef: { current: null },
    isRevertingCheckpoint: () => false,
    pendingThreadImportsRef: { current: new Map() },
    setComposerCursor: () => {},
    setComposerTrigger: () => {},
    importContextRecords: () => new Map(),
    expandMobileComposer: () => {},
  });
  const handler = state.stashHandlers.at(-1)!;
  expect(handler).toBeTypeOf("function");
  return {
    hook,
    promptRef,
    stash: () =>
      handler({ preventDefault: () => {}, stopPropagation: () => {} } as unknown as KeyboardEvent),
  };
}

function holdOriginalImage(f: Awaited<ReturnType<typeof setup>>, succeeds: boolean) {
  const file = new File(["original local image bytes"], "original.png", { type: "image/png" });
  f.store.addImages(f.editTarget, [
    {
      id: "live-image",
      type: "image",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
      previewUrl: "blob:live",
    },
  ]);
  const reading = deferred<void>();
  const release = deferred<void>();
  let reads = 0;
  vi.stubGlobal(
    "FileReader",
    class extends EventTarget {
      result: string | null = null;
      readAsDataURL(blob: Blob) {
        if (++reads === 1) {
          reading.resolve();
          void release.promise.then(async () => {
            if (succeeds) {
              this.result = `data:${blob.type};base64,${btoa(await blob.text())}`;
              this.dispatchEvent(new Event("load"));
            } else this.dispatchEvent(new Event("error"));
          });
        } else this.dispatchEvent(new Event("error"));
      }
    },
  );
  return { file, reading, release, reads: () => reads };
}

it.each([true, false])(
  "refuses the registered stash shortcut while recovery owns bytes, with recovery success %s",
  async (succeeds) => {
    const f = await setup();
    const image = holdOriginalImage(f, succeeds);
    const binding = await bindStash(f);
    f.leave();
    await image.reading.promise;
    expect(f.read().isSaving).toBe(true);
    binding.stash();
    const retained = f.store.getComposerDraft(f.editTarget)?.images[0]?.file === image.file;
    image.release.resolve();
    await f.done.promise;
    expect(retained).toBe(true);
    expect(image.reads()).toBe(1);
    if (succeeds) {
      const entry = f.usePromptStashStore.getState().entries[0]!;
      expect(entry.recovery?.queuedEdit).toBeDefined();
      expect(entry.attachments[0]?.dataUrl).toBe(
        `data:image/png;base64,${btoa("original local image bytes")}`,
      );
      expect(entry.unreadableImageNames).toBeUndefined();
      f.store.setPrompt(f.editTarget, "Later unowned draft");
      binding.promptRef.current = "Later unowned draft";
      binding.stash();
      expect(f.usePromptStashStore.getState().entries[0]?.prompt).toBe("Later unowned draft");
      expect(f.store.getComposerDraft(f.editTarget)?.prompt ?? "").toBe("");
    } else {
      expect(f.store.getComposerDraft(f.editTarget)?.images[0]?.file).toBe(image.file);
      expect(f.usePromptStashStore.getState().entries).toEqual([]);
      expect(f.read().isEditing).toBe(true);
    }
  },
);

it("refuses manual restore into the owned edit without taking its stash copy", async () => {
  const f = await setup();
  const image = holdOriginalImage(f, false);
  const entry = {
    id: "other-copy",
    createdAt: "2026-10-27",
    prompt: "Other stashed text",
    attachments: [],
    droppedImageNames: [],
  };
  f.usePromptStashStore.getState().stashEntry(entry);
  const binding = await bindStash(f);
  f.leave();
  await image.reading.promise;
  await binding.hook.restoreStashEntryStable(entry);
  const source = f.store.getComposerDraft(f.editTarget);
  const copy = f.usePromptStashStore.getState().entries.find((value) => value.id === entry.id);
  image.release.resolve();
  await f.done.promise;
  expect(source?.prompt).toBe(f.prompt);
  expect(source?.images[0]?.file).toBe(image.file);
  expect(copy).toBeDefined();
});

it("permits deleting a stash copy to free capacity but protects handles owned only by the live queued edit", async () => {
  const f = await setup([
    {
      id: "queue-upload",
      type: "file",
      name: "original.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
    },
  ]);
  const image = holdOriginalImage(f, false);
  const entry = {
    id: "other-file-copy",
    createdAt: "2026-10-27",
    prompt: "Other copy",
    attachments: [],
    files: [
      {
        id: "other-file",
        name: "original.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
        attachmentId: "queue-upload",
        environmentId: f.environmentId,
      },
    ],
    droppedImageNames: [],
  };
  f.usePromptStashStore.getState().stashEntry(entry);
  const binding = await bindStash(f);
  f.leave();
  await image.reading.promise;
  binding.hook.deleteStashEntryStable(entry);
  const deletions = state.rpc.mock.calls
    .filter(([, command]) => command === "remove")
    .map(([, , target]) => target);
  image.release.resolve();
  await f.done.promise;
  expect(f.usePromptStashStore.getState().entries).toEqual([]);
  expect(deletions).toEqual([]);
  expect(f.store.getComposerDraft(f.editTarget)?.images[0]?.file).toBe(image.file);
});

it("rechecks live queued ownership after manual restore verification before taking the entry", async () => {
  const f = await setup();
  await f.read().cancelEdit();
  const entry = {
    id: "waiting-restore",
    createdAt: "2026-10-27",
    prompt: "Stashed file",
    attachments: [],
    files: [
      {
        id: "restored-file",
        name: "a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
        attachmentId: "restore-upload",
        environmentId: f.environmentId,
      },
    ],
    droppedImageNames: [],
  };
  f.usePromptStashStore.getState().stashEntry(entry);
  const binding = await bindStash(f);
  const verifying = deferred<void>();
  const reply = deferred<Awaited<ReturnType<typeof state.query>>>();
  state.query.mockImplementation(() => {
    verifying.resolve();
    return reply.promise;
  });
  const pending = binding.hook.restoreStashEntryStable(entry);
  await verifying.promise;
  f.read().beginEdit({
    runId: f.runId,
    messageId: MessageId.make("new-claim"),
    text: "New owned edit",
    attachments: [],
  });
  reply.resolve(AsyncResult.success({ relativeUrl: "/verified" }));
  await pending;
  expect(f.store.getComposerDraft(f.editTarget)?.prompt).toBe("New owned edit");
  expect(f.store.getComposerDraft(f.editTarget)?.files).toEqual([]);
  expect(f.usePromptStashStore.getState().entries.some((value) => value.id === entry.id)).toBe(
    true,
  );
});

it("allows an unrelated normal composer to stash while queued recovery retains its source", async () => {
  const f = await setup();
  const image = holdOriginalImage(f, false);
  const normal = await bindStash(f, f.routeThreadRef);
  f.leave();
  await image.reading.promise;
  normal.stash();
  expect(f.store.getComposerDraft(f.editTarget)?.images[0]?.file).toBe(image.file);
  expect(f.usePromptStashStore.getState().entries[0]?.prompt).toBe("Separate composer");
  image.release.resolve();
  await f.done.promise;
  expect(f.store.getComposerDraft(f.editTarget)?.images[0]?.file).toBe(image.file);
});

it("does not claim original byte ownership when another action removes the current source", async () => {
  const f = await setup();
  const image = holdOriginalImage(f, false);
  f.leave();
  await image.reading.promise;
  f.store.clearComposerContent(f.editTarget);
  image.release.resolve();
  await f.done.promise;
  const notice = state.notifications.at(-1)!;
  expect(notice.title).toBe("Queued edit recovery did not finish");
  expect(notice.description).toContain("changed or was removed");
  expect(notice.description).not.toContain("remain owned by the edit");
});
