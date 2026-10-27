import { useComposerDraftStore, type ComposerThreadTarget } from "../composerDraftStore";
import { prepareSpaceContextSend } from "@t2code/client-runtime/spaces";
import { runAtomCommand } from "@t2code/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type ComposerContextDraft,
  type EnvironmentId,
  type OrchestrationMessageContext,
} from "@t2code/contracts";
import { collectComposerContextReferences } from "@t2code/shared/composerContextReferences";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { spacesEnvironment } from "../state/spaces";
import { readEnvironmentScope } from "../state/session";
import { environmentServerConfigsAtom } from "../state/server";

export async function prepareComposerSendContext(input: {
  environmentId: EnvironmentId;
  text: string;
  context?: OrchestrationMessageContext | undefined;
  contextDraft?: ComposerContextDraft | undefined;
  isCurrentDraft: () => boolean;
}) {
  const records = [...(input.context?.records ?? []), ...(input.contextDraft?.records ?? [])];
  const candidates = [...records, ...(input.contextDraft?.selectors ?? [])];
  const hasSpaces = collectComposerContextReferences(input.text).some((reference) => {
    const matches = candidates.filter((record) => record.contextId === reference.contextId);
    return (
      matches.some((record) => record.kind === "page" || record.kind === "block") ||
      (matches.length === 0 && (reference.kind === "page" || reference.kind === "block"))
    );
  });
  const session = hasSpaces
    ? await runAtomCommand(
        appAtomRegistry,
        spacesEnvironment.captureSession,
        { environmentId: input.environmentId, input: undefined },
        { reportFailure: false },
      )
    : null;
  const currentSession = session?._tag === "Success" ? session.value : () => null;
  const access = () => {
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(input.environmentId);
    return {
      session: currentSession(),
      canRead: readEnvironmentScope(input.environmentId, AuthOrchestrationReadScope),
      supportsCapture:
        config?.environment.capabilities.spaces?.version === 2 &&
        config.environment.capabilities.inlineMessageContext === true,
    };
  };
  const context = await prepareSpaceContextSend({
    ...input,
    context: records.length ? { ...input.context, version: 1, records } : input.context,
    selectors: input.contextDraft?.selectors,
    access,
    capture: async (captureInput) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        spacesEnvironment.capture,
        { environmentId: input.environmentId, input: captureInput },
        { reportFailure: false },
      );
      if (result._tag === "Failure")
        throw new Error("Could not capture Spaces context. Retry or remove it before sending.");
      return result.value;
    },
  });
  if (input.contextDraft && !input.isCurrentDraft())
    throw new Error(
      "The draft changed while preparing context. Send again to include your latest draft.",
    );
  const initialSession = currentSession();
  return {
    context,
    assertCurrent: () => {
      if (!hasSpaces) return;
      const current = access();
      if (
        initialSession === null ||
        current.session !== initialSession ||
        !current.canRead ||
        !current.supportsCapture
      )
        throw new Error("Spaces access changed before sending. Retry or remove its context.");
    },
  };
}

export function composerDraftSendGuard(target: ComposerThreadTarget) {
  const signature = () => {
    const draft = useComposerDraftStore.getState().getComposerDraft(target);
    return JSON.stringify([
      draft?.prompt,
      draft?.images.map((image) => image.id),
      draft?.files.map((file) => file.id),
      draft?.terminalContexts,
      draft?.reviewComments,
      draft?.previewAnnotations,
      draft?.threadContexts,
      draft?.contextDraft,
      draft?.modelSelectionByProvider,
      draft?.activeProvider,
      draft?.runtimeMode,
      draft?.interactionMode,
    ]);
  };
  const original = signature();
  return () => signature() === original;
}
