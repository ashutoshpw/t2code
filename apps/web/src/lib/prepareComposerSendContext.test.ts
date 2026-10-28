import { expect, it } from "vite-plus/test";
import {
  ComposerContextId,
  EnvironmentId,
  type SpaceContextCaptureResult,
  ThreadId,
} from "@t2code/contracts";
import { SpacePageId } from "@t2code/contracts/spaces";
import { prepareSpaceContextSend } from "@t2code/client-runtime/spaces";
import { scopeThreadRef } from "@t2code/client-runtime/environment";
import { useComposerDraftStore } from "../composerDraftStore";
import { composerDraftSendGuard } from "./prepareComposerSendContext";

it.each(["typing", "child option"])(
  "retains a changed %s while a send capture is deferred",
  async (change) => {
    const target = scopeThreadRef(
      EnvironmentId.make("capture-env"),
      ThreadId.make("capture-thread"),
    );
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
    let resolveReply!: (value: SpaceContextCaptureResult) => void;
    const reply = new Promise<SpaceContextCaptureResult>((resolve) => {
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
    if (change === "typing") store.setPrompt(target, `${draft.prompt} newer typing`);
    else store.setSpaceContextIncludeChildPages(target, draft.contextDraft!.selectors[0]!, true);
    resolveReply({ status: "unavailable" });
    await expect(pending).rejects.toThrow("draft changed");
    expect(store.getComposerDraft(target)?.prompt).toBe(
      change === "typing" ? `${draft.prompt} newer typing` : draft.prompt,
    );
    expect(store.getComposerDraft(target)?.contextDraft?.selectors[0]?.includeChildPages).toBe(
      change !== "typing",
    );
    store.clearComposerContent(target);
  },
);
