import {
  prepareSpaceContextSend,
  supportsSpaceContextCapture,
} from "@t2code/client-runtime/spaces";
import { collectComposerContextReferences } from "@t2code/shared/composerContextReferences";
import { useAtomValue } from "@effect/atom-react";
import {
  createSpacesEnvironmentAtoms,
  spacesAvailability,
  canBrowseSpaces,
} from "@t2code/client-runtime/state/spaces";
import {
  createEnvironmentRpcQueryAtomFamily,
  executeAtomQuery,
  runAtomCommand,
} from "@t2code/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  WS_METHODS,
  sessionGrantsScope,
  type EnvironmentId,
  type ComposerContextDraft,
  type OrchestrationMessageContext,
  type AuthSessionState,
} from "@t2code/contracts";
import type { SpaceCapability } from "@t2code/contracts/spaces";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { environmentSession } from "./session";
import { SpacesPageReader, type SpacesReadAccess } from "../features/spaces/reader";

export const spacesEnvironment = createSpacesEnvironmentAtoms(connectionAtomRuntime);
const blocks = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:spaces:blocks",
  tag: WS_METHODS.spacesBlocksRead,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
const reference = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:spaces:reference",
  tag: WS_METHODS.spacesReferencesResolve,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

interface AccessState {
  readonly session: AuthSessionState | null;
  readonly connection: { readonly phase: string } | null;
  readonly capability: SpaceCapability | undefined;
}

function captureAccess(environmentId: EnvironmentId, original: AccessState): SpacesReadAccess {
  const availability = spacesAvailability({
    connected: original.connection?.phase === "connected",
    capability: original.capability,
    canRead:
      original.session !== null && sessionGrantsScope(original.session, AuthOrchestrationReadScope),
    canOperate:
      original.session !== null &&
      sessionGrantsScope(original.session, AuthOrchestrationOperateScope),
  });
  return {
    availability,
    capability: original.capability,
    current: () => {
      const result = appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId));
      const session =
        result._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(result));
      const connection = Option.getOrNull(
        AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(environmentId))),
      );
      const capability = appAtomRegistry.get(
        environmentPresentations.presentationAtom(environmentId),
      )?.serverConfig?.environment.capabilities.spaces;
      return (
        canBrowseSpaces(availability) &&
        session === original.session &&
        connection === original.connection &&
        capability === original.capability
      );
    },
  };
}

export function useSpacesReadAccess(environmentId: EnvironmentId) {
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const connection = useAtomValue(environmentCatalog.stateAtom(environmentId));
  const presentation = useAtomValue(environmentPresentations.presentationAtom(environmentId));
  return useMemo(
    () =>
      captureAccess(environmentId, {
        session: session._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(session)),
        connection: Option.getOrNull(AsyncResult.value(connection)),
        capability: presentation?.serverConfig?.environment.capabilities.spaces,
      }),
    [environmentId, session, connection, presentation],
  );
}

export function createSpacesPageReader(
  target: SpacePageNavigationTarget,
  access: SpacesReadAccess,
) {
  const query = async <A, E>(
    atom: import("effect/reactivity").Atom.Atom<AsyncResult.AsyncResult<A, E>>,
    signal: AbortSignal,
  ) => {
    const result = await executeAtomQuery(appAtomRegistry, atom, {
      refresh: true,
      reportFailure: false,
      signal,
    });
    if (result._tag === "Failure") throw Cause.squash(result.cause);
    return result.value;
  };
  return new SpacesPageReader(target, {
    access,
    locate: async (signal) => {
      let pageId = target.pageId;
      let resolvedBlockId = target.blockId;
      if (
        target.blockId &&
        access.capability?.version === 2 &&
        access.capability.features?.referenceResolution === true
      ) {
        const result = await query(
          reference({
            environmentId: target.environmentId,
            input: {
              environmentId: target.environmentId,
              target: { kind: "block", blockId: target.blockId },
            },
          }),
          signal,
        );
        if (
          !access.current() ||
          new TextEncoder().encode(JSON.stringify(result)).byteLength > 16384
        )
          throw new Error("The source connection changed. Open the link again.");
        if (result.status !== "resolved" && result.status !== "merged")
          throw new Error("The linked block is unavailable or in trash.");
        pageId = result.page.id;
        resolvedBlockId = result.blockId;
      }
      const location = await query(
        spacesEnvironment.location({
          environmentId: target.environmentId,
          input: {
            environmentId: target.environmentId,
            pageId,
            version: access.capability?.version === 1 ? 1 : 2,
          },
        }),
        signal,
      );
      return { ...location, ...(resolvedBlockId ? { resolvedBlockId } : {}) };
    },
    blocks: (input, signal) =>
      query(blocks({ environmentId: target.environmentId, input }), signal),
  });
}

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
