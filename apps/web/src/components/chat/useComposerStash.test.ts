import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t2code/contracts";
import { scopeThreadRef } from "@t2code/client-runtime/environment";

const transport = vi.hoisted(() => {
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
  return { remove: vi.fn(), navigate: vi.fn() };
});
vi.mock("react", async () => ({
  ...(await vi.importActual<typeof import("react")>("react")),
  useRef: <A>(current: A) => ({ current }),
  useState: <A>(initial: A | (() => A)) => [
    typeof initial === "function" ? (initial as () => A)() : initial,
    () => {},
  ],
  useLayoutEffect: () => {},
  useEffect: () => {},
  use: () => false,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => transport.navigate }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../../state/session", async () => ({
  ...(await vi.importActual<typeof import("../../state/session")>("../../state/session")),
  readEnvironmentScope: () => true,
}));
vi.mock("@t2code/client-runtime/state/runtime", async () => ({
  ...(await vi.importActual<typeof import("@t2code/client-runtime/state/runtime")>(
    "@t2code/client-runtime/state/runtime",
  )),
  executeAtomQuery: async () => ({ _tag: "Success", value: {} }),
  runAtomCommand: async (_registry: unknown, _command: unknown, input: unknown) => {
    transport.remove(input);
    return { _tag: "Success", value: undefined };
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
vi.mock("../../promptStashStore", async () => {
  const actual =
    await vi.importActual<typeof import("../../promptStashStore")>("../../promptStashStore");
  const store = actual.usePromptStashStore;
  return {
    ...actual,
    usePromptStashStore: Object.assign(
      (select: (value: ReturnType<typeof store.getState>) => unknown) => select(store.getState()),
      store,
    ),
  };
});

async function loadOwners() {
  return {
    ...(await import("../../composerDraftStore")),
    ...(await import("../../promptStashStore")),
    ...(await import("../../lib/composerSendRecovery")),
    ...(await import("./useComposerStash")),
  };
}

it("deleting recovery copies preserves uploads held by any composer or remaining stash", async () => {
  transport.remove.mockClear();
  let {
    useComposerDraftStore,
    usePromptStashStore,
    reserveComposerSendRecovery,
    restoreComposerSendRecovery,
    useComposerStash,
  } = await loadOwners();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  usePromptStashStore.setState({ entries: [], activeRecoveryIds: [] });
  const environmentId = EnvironmentId.make("recovery-files");
  const threadId = ThreadId.make("origin");
  const target = scopeThreadRef(environmentId, threadId);
  const otherTarget = scopeThreadRef(environmentId, ThreadId.make("other-composer"));
  let store = useComposerDraftStore.getState();
  const file = {
    type: "file" as const,
    id: "original-file",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 5,
    file: null,
    uploadedAttachmentId: "pending-report-pdf",
    uploadEnvironmentId: environmentId,
  };
  store.setPrompt(target, "Keep the report");
  store.addFiles(target, [file]);
  await reserveComposerSendRecovery({
    id: "failed-send",
    environmentId,
    threadId,
    draftId: null,
    target,
    contents: store.getComposerDraft(target)!,
    assertCurrent: () => {},
  });
  usePromptStashStore.getState().settleSendRecovery("failed-send", false);
  store.clearComposerContent(target);
  vi.resetModules();
  ({
    useComposerDraftStore,
    usePromptStashStore,
    reserveComposerSendRecovery,
    restoreComposerSendRecovery,
    useComposerStash,
  } = await loadOwners());
  store = useComposerDraftStore.getState();
  store.clearComposerContent(target);
  await restoreComposerSendRecovery({
    entryId: "failed-send",
    environmentId,
    target,
    isCurrent: () => true,
  });
  const retained = usePromptStashStore.getState().entries[0]!;
  const hook = useComposerStash({
    environmentId,
    composerDraftTarget: target,
    promptRef: { current: "Keep the report" },
    routeThreadRef: target,
    prompt: "Keep the report",
    composerMenuOpen: false,
  } as Parameters<typeof useComposerStash>[0]);
  hook.deleteStashEntryStable(retained);
  expect(transport.remove).not.toHaveBeenCalled();
  expect(store.getComposerDraft(target)?.files[0]?.uploadedAttachmentId).toBe("pending-report-pdf");
  expect(usePromptStashStore.getState().entries).toEqual([]);

  // A different composer and local file ID still own the same upload.
  store.clearComposerContent(target);
  store.addFiles(otherTarget, [{ ...file, id: "other-local-id" }]);
  usePromptStashStore.getState().stashEntry({ ...retained, id: "other-composer-copy" });
  hook.deleteStashEntryStable(usePromptStashStore.getState().entries[0]!);
  expect(transport.remove).not.toHaveBeenCalled();
  store.clearComposerContent(otherTarget);

  usePromptStashStore.getState().stashEntry({ ...retained, id: "first-copy" });
  usePromptStashStore.getState().stashEntry({
    ...retained,
    id: "second-copy",
    files: (retained.files ?? []).map((saved) => ({ ...saved, id: "different-stashed-id" })),
  });
  hook.deleteStashEntryStable(
    usePromptStashStore.getState().entries.find((entry) => entry.id === "first-copy")!,
  );
  expect(transport.remove).not.toHaveBeenCalled();

  // Legacy ownership with a missing environment is uncertain, so retain it.
  const { uploadEnvironmentId: _environment, ...uncertainFile } = file;
  const uncertainTarget = scopeThreadRef(
    EnvironmentId.make("another-environment"),
    ThreadId.make("uncertain-owner"),
  );
  store.addFiles(uncertainTarget, [uncertainFile]);
  hook.deleteStashEntryStable(usePromptStashStore.getState().entries[0]!);
  expect(transport.remove).not.toHaveBeenCalled();
  store.clearComposerContent(uncertainTarget);

  usePromptStashStore.getState().stashEntry({ ...retained, id: "exclusive-copy" });
  hook.deleteStashEntryStable(usePromptStashStore.getState().entries[0]!);
  expect(transport.remove.mock.calls).toEqual([
    [{ environmentId, input: { attachmentId: "pending-report-pdf" } }],
  ]);
});
