import {
  prepareSpaceContextSend,
  supportsSpaceContextCapture,
} from "@t2code/client-runtime/spaces";
import { collectComposerContextReferences } from "@t2code/shared/composerContextReferences";
import {
  AuthOrchestrationReadScope,
  type ComposerContextDraft,
  type EnvironmentId,
  type OrchestrationMessageContext,
} from "@t2code/contracts";
import { createSpacesEnvironmentAtoms } from "@t2code/client-runtime/state/spaces";
import { runAtomCommand } from "@t2code/client-runtime/state/runtime";

export async function prepareMobileComposerContext(input: {
  environmentId: EnvironmentId;
  text: string;
  context?: OrchestrationMessageContext | undefined;
  contextDraft?: ComposerContextDraft | undefined;
  isCurrentDraft?: (() => boolean) | undefined;
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
  if (
    !hasSpaces &&
    !candidates.some((record) => record.kind === "page" || record.kind === "block") &&
    !input.contextDraft?.records.length
  )
    return input.context;
  if (!hasSpaces)
    return prepareSpaceContextSend({
      ...input,
      context: records.length ? { ...input.context, version: 1, records } : input.context,
      selectors: input.contextDraft?.selectors,
      isCurrentDraft: input.isCurrentDraft ?? (() => true),
      access: () => ({ session: null, canRead: false, supportsCapture: false }),
    });
  const [
    { connectionAtomRuntime },
    { appAtomRegistry },
    { readEnvironmentScope },
    { environmentServerConfigsAtom },
  ] = await Promise.all([
    import("../connection/runtime"),
    import("./atom-registry"),
    import("./session"),
    import("./server"),
  ]);
  const spacesEnvironment = createSpacesEnvironmentAtoms(connectionAtomRuntime);
  const session = await runAtomCommand(
    appAtomRegistry,
    spacesEnvironment.captureSession,
    { environmentId: input.environmentId, input: undefined },
    { reportFailure: false },
  );
  const currentSession = session._tag === "Success" ? session.value : () => null;
  return prepareSpaceContextSend({
    ...input,
    context: { ...input.context, version: 1, records },
    selectors: input.contextDraft?.selectors,
    isCurrentDraft: input.isCurrentDraft ?? (() => true),
    access: () => ({
      session: currentSession(),
      canRead: readEnvironmentScope(input.environmentId, AuthOrchestrationReadScope),
      supportsCapture: supportsSpaceContextCapture(
        appAtomRegistry.get(environmentServerConfigsAtom).get(input.environmentId)?.environment
          .capabilities.spaces,
        appAtomRegistry.get(environmentServerConfigsAtom).get(input.environmentId)?.environment
          .capabilities.inlineMessageContext === true,
      ),
    }),
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
}
