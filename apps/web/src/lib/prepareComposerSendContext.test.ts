import { expect, it } from "vite-plus/test";
import {
  ComposerContextId,
  EnvironmentId,
  type PageContextRecord,
  ThreadId,
} from "@t2code/contracts";
import { SpaceId, SpacePageId } from "@t2code/contracts/spaces";
import { prepareSpaceContextSend } from "@t2code/client-runtime/spaces";
import { scopeThreadRef } from "@t2code/client-runtime/environment";
import { useComposerDraftStore } from "../composerDraftStore";
import { composerDraftSendGuard } from "./prepareComposerSendContext";

it("retains newer typing and selector generation while a send capture is deferred", async () => {
  const target = scopeThreadRef(EnvironmentId.make("capture-env"), ThreadId.make("capture-thread"));
  const store = useComposerDraftStore.getState();
  const selector = {
    version: 1 as const,
    selection: "current" as const,
    kind: "page" as const,
    environmentId: target.environmentId,
    contextId: ComposerContextId.make("p"),
    label: "Page",
    pageId: SpacePageId.make("page"),
    includeChildPages: false,
  };
  store.setPrompt(target, "[Page](t2-context://v1/page/p)");
  store.setContextDraft(target, { selectors: [selector], records: [] });
  const draft = store.getComposerDraft(target)!;
  const unchanged = composerDraftSendGuard(target);
  let resolveReply!: (value: { status: "captured"; record: PageContextRecord }) => void;
  const reply = new Promise<{ status: "captured"; record: PageContextRecord }>((resolve) => {
    resolveReply = resolve;
  });
  const session = {};
  const pending = prepareSpaceContextSend({
    environmentId: target.environmentId,
    text: draft.prompt,
    selectors: draft.contextDraft?.selectors,
    access: () => ({ session, canRead: true, supportsCapture: true }),
    isCurrentDraft: unchanged,
    capture: () => reply,
  });
  store.setPrompt(target, `${draft.prompt} newer typing`);
  const spaceId = SpaceId.make("s");
  resolveReply({
    status: "captured",
    record: {
      version: 1,
      kind: "page",
      contextId: selector.contextId,
      label: "Page",
      environmentId: target.environmentId,
      pageId: selector.pageId,
      spaceId,
      title: "Page",
      snapshot: {
        version: 1,
        includeChildPages: false,
        truncated: false,
        text: "Captured",
        contentHash: `sha256:${"a".repeat(64)}`,
        sources: [
          {
            environmentId: target.environmentId,
            pageId: selector.pageId,
            spaceId,
            revision: 1,
            blockIds: [],
          },
        ],
      },
    },
  });
  await expect(pending).rejects.toThrow("draft changed");
  expect(store.getComposerDraft(target)?.prompt).toBe(`${draft.prompt} newer typing`);
  expect(store.getComposerDraft(target)?.contextDraft).toEqual(draft.contextDraft);
  const latest = composerDraftSendGuard(target);
  store.setContextDraft(target, {
    selectors: [{ ...selector, includeChildPages: true }],
    records: [],
  });
  expect(latest()).toBe(false);
  store.clearComposerContent(target);
});
