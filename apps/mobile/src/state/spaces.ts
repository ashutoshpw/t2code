import {
  prepareSpaceContextSend,
  supportsSpaceContextCapture,
} from "@t2code/client-runtime/spaces";
import { collectComposerContextReferences } from "@t2code/shared/composerContextReferences";
import type { ComposerContextDraft, OrchestrationMessageContext } from "@t2code/contracts";
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
  type AuthSessionState,
} from "@t2code/contracts";
import type { SpaceCapability } from "@t2code/contracts/spaces";
import {
  SpaceDocumentSession,
  type SpaceReferenceController,
  createSpaceServiceSessionAdapter,
  type SpacePageNavigationTarget,
  type SpaceRootReorder,
} from "@t2code/client-runtime/spaces";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { environmentSession } from "./session";
import * as Runtime from "../lib/runtime";
import { uuidv4 } from "../lib/uuid";
import {
  MobileSpaceDocuments,
  acquireHydratedSpacesPageReader,
} from "../features/spaces/documents";
import {
  createMobileSpaceDraftStore,
  createMobileSpaceStructureStore,
} from "../features/spaces/draftStore";
import { createMobileSpaceStructure } from "../features/spaces/structure";
import { createMobileSpaceReferenceController } from "../features/spaces/references";
import { SpacesPageReader, type SpacesReadAccess } from "../features/spaces/reader";

const capabilityAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.map(
    environmentPresentations.presentationAtom(environmentId),
    (value) => value?.serverConfig?.environment.capabilities.spaces,
  ),
);
export const spacesEnvironment = createSpacesEnvironmentAtoms(connectionAtomRuntime, {
  capabilityAtom,
});
const blocks = spacesEnvironment.blocks;
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

function liveAccess(environmentId: EnvironmentId) {
  const session = appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId));
  return captureAccess(environmentId, {
    session: session._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(session)),
    connection: Option.getOrNull(
      AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(environmentId))),
    ),
    capability: appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))
      ?.serverConfig?.environment.capabilities.spaces,
  });
}

function requireAccess(environmentId: EnvironmentId, write = false, library = false) {
  const access = liveAccess(environmentId);
  if (
    !canBrowseSpaces(access.availability) ||
    !access.current() ||
    !access.capability ||
    (write && (access.availability !== "writable" || (!library && access.capability.version !== 2)))
  )
    throw new Error("Spaces is unavailable for this connection or permission.");
  return { ...access, capability: access.capability };
}

const receipts = spacesEnvironment.receipt;
const apply = spacesEnvironment.apply;
const drafts = createMobileSpaceDraftStore(() => Runtime.runtime.context());

async function query<A, E>(
  atom: import("effect/reactivity").Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  signal?: AbortSignal,
) {
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    refresh: true,
    reportFailure: false,
    ...(signal ? { signal } : {}),
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

export function createSpacesPageReader(
  target: SpacePageNavigationTarget,
  access?: SpacesReadAccess,
) {
  if (target.blockId) throw new Error("Resolve a block link before creating its page session.");
  const key = { environmentId: target.environmentId, pageId: target.pageId };
  let reader: SpacesPageReader | undefined;
  const adapter = createSpaceServiceSessionAdapter(key, {
    limits: () => requireAccess(key.environmentId, true).capability.limits,
    getPage: async (input) => {
      const owner = requireAccess(key.environmentId);
      const result = await query(
        spacesEnvironment.page({ environmentId: key.environmentId, input }),
      );
      if (!owner.current())
        throw new Error("Spaces connection changed; retain the pending request.");
      return result;
    },
    lookupMutationReceipt: async (input) => {
      const owner = requireAccess(key.environmentId);
      const result = await query(receipts({ environmentId: key.environmentId, input }));
      if (!owner.current())
        throw new Error("Spaces connection changed; retain the pending request.");
      return result;
    },
    applyBlockBatch: async (input) => {
      const owner = requireAccess(key.environmentId, true);
      const result = await apply.run(appAtomRegistry, { environmentId: key.environmentId, input });
      if (!owner.current())
        throw new Error("Spaces connection changed; recover the exact receipt.");
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      return result.value;
    },
  });
  const session = new SpaceDocumentSession(key, {
    adapter,
    drafts,
    createMutationId: uuidv4,
    assertMutable: () => {
      requireAccess(key.environmentId, true);
      getMobileSpaceStructure(key.environmentId).assertReady();
      documents.assertUnreserved(key);
      reader?.assertContentReady();
    },
    maxLoadedBlocks: 100,
    maxMutations: 100,
  });
  reader = new SpacesPageReader(target, {
    session,
    beforeRead: () => getMobileSpaceStructure(key.environmentId).hydrate(),
    get access() {
      return access ?? liveAccess(key.environmentId);
    },
    locate: (signal) =>
      query(
        spacesEnvironment.location({
          environmentId: key.environmentId,
          input: {
            ...key,
            version: requireAccess(key.environmentId).capability.version === 1 ? 1 : 2,
          },
        }),
        signal,
      ),
    blocks: (input, signal) => query(blocks({ environmentId: key.environmentId, input }), signal),
    confirmDeleted: async (signal) => {
      const owner = requireAccess(key.environmentId);
      if (owner.capability.version !== 2 || owner.capability.features?.referenceResolution !== true)
        return false;
      const result = await query(
        reference({
          environmentId: key.environmentId,
          input: { environmentId: key.environmentId, target: { kind: "page", pageId: key.pageId } },
        }),
        signal,
      );
      if (!owner.current())
        throw new Error("The connection changed while confirming page deletion");
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 16384)
        throw new Error("The deletion result exceeds its read limit");
      return result.status === "deleted";
    },
  });
  return reader;
}

const documents = new MobileSpaceDocuments((target) => createSpacesPageReader(target));
const structures = new Map<EnvironmentId, SpaceRootReorder>();

export function getMobileSpaceStructure(environmentId: EnvironmentId) {
  const existing = structures.get(environmentId);
  if (existing) return existing;
  if (structures.size >= 8)
    throw new Error("Mobile Spaces supports eight environment journals on this device");
  const access = (write: boolean, library = false) => {
    const owner = requireAccess(environmentId, write, library);
    if (!library && owner.capability.version !== 2)
      throw new Error("Page structure requires a current Spaces environment");
    return owner;
  };
  const read = async <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) => {
    const owner = access(false, true);
    try {
      const result = await query(atom);
      if (!owner.current())
        throw new Error("The connection changed; ignore the old structural result");
      return result;
    } catch (error) {
      if (!owner.current())
        throw new Error("The connection changed; retain the structural operation", {
          cause: error,
        });
      throw error;
    }
  };
  const mutate = async <A, E>(
    work: () => Promise<
      | { readonly _tag: "Success"; readonly value: A }
      | { readonly _tag: "Failure"; readonly cause: Cause.Cause<E> }
    >,
    library = false,
  ) => {
    const owner = access(true, library);
    const result = await work();
    if (!owner.current())
      throw new Error("The connection changed; recover the exact structural receipt");
    if (result._tag === "Failure") throw Cause.squash(result.cause);
    return result.value;
  };
  const coordinator = createMobileSpaceStructure(environmentId, {
    store: createMobileSpaceStructureStore(() => Runtime.runtime.context()),
    drafts,
    documents,
    newId: uuidv4,
    capability: () => liveAccess(environmentId).capability,
    assertAccess: (write) => {
      access(write);
    },
    libraryAccess: (write) => {
      access(write, true);
    },
    maxRows: () => access(false, true).capability.limits.maxListRows,
    maxMutationBytes: () => access(true).capability.limits.maxMutationBytes,
    spaces: (input) => read(spacesEnvironment.list({ environmentId, input })),
    list: (input) => read(spacesEnvironment.pages({ environmentId, input })),
    getPage: (pageId) =>
      read(spacesEnvironment.page({ environmentId, input: { environmentId, pageId } })),
    blocks: (input) =>
      read(
        blocks({
          environmentId,
          input: {
            ...input,
            limit: Math.min(
              input.limit ?? 100,
              access(false).capability.limits.maxBlockWindowBlocks,
            ),
          },
        }),
      ),
    inspect: (input) => read(spacesEnvironment.inspect({ environmentId, input })),
    receipt: (input) => read(receipts({ environmentId, input })),
    library: async (request) => {
      switch (request.operation) {
        case "createSpace":
          return {
            operation: request.operation,
            result: await mutate(
              () =>
                spacesEnvironment.createSpace.run(appAtomRegistry, {
                  environmentId,
                  input: request.input,
                }),
              true,
            ),
          };
        case "renameSpace":
          return {
            operation: request.operation,
            result: await mutate(
              () =>
                spacesEnvironment.renameSpace.run(appAtomRegistry, {
                  environmentId,
                  input: request.input,
                }),
              true,
            ),
          };
        case "setDefaultSpace":
          return {
            operation: request.operation,
            result: await mutate(
              () =>
                spacesEnvironment.setDefaultSpace.run(appAtomRegistry, {
                  environmentId,
                  input: request.input,
                }),
              true,
            ),
          };
        case "createPage":
          return {
            operation: request.operation,
            result: await mutate(
              () =>
                spacesEnvironment.createPage.run(appAtomRegistry, {
                  environmentId,
                  input: request.input,
                }),
              true,
            ),
          };
        case "updatePage":
          return {
            operation: request.operation,
            result: await mutate(
              () =>
                spacesEnvironment.updatePage.run(appAtomRegistry, {
                  environmentId,
                  input: request.input,
                }),
              true,
            ),
          };
      }
    },
    createChild: (input) =>
      mutate(() => spacesEnvironment.createChild.run(appAtomRegistry, { environmentId, input })),
    move: (input) =>
      mutate(() => spacesEnvironment.movePage.run(appAtomRegistry, { environmentId, input })),
    recovery: (operation, input) =>
      mutate(() =>
        (operation === "trashPage"
          ? spacesEnvironment.trashPage
          : spacesEnvironment.restorePage
        ).run(appAtomRegistry, { environmentId, input }),
      ),
    trashList: (input) => read(spacesEnvironment.trash({ environmentId, input })),
    purge: (input) =>
      mutate(() =>
        spacesEnvironment.permanentlyDeletePage.run(appAtomRegistry, { environmentId, input }),
      ),
    moveBlocks: (input) =>
      mutate(() => spacesEnvironment.moveBlocks.run(appAtomRegistry, { environmentId, input })),
    changed: () =>
      appAtomRegistry.update(spacesEnvironment.changed(environmentId), (value) => value + 1),
  });
  structures.set(environmentId, coordinator);
  return coordinator;
}

export async function acquireSpacesPageReader(
  target: SpacePageNavigationTarget,
  access: SpacesReadAccess,
  signal: AbortSignal,
) {
  let resolved = target;
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
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 16384)
      throw new Error("The linked block exceeds its read limit.");
    if (result.status !== "resolved" && result.status !== "merged")
      throw new Error("The linked block is unavailable or in trash.");
    resolved = {
      environmentId: target.environmentId,
      spaceId: result.page.spaceId,
      pageId: result.page.id,
      ...(result.blockId ? { blockId: result.blockId } : {}),
    };
  }
  return acquireHydratedSpacesPageReader(resolved, access, signal, {
    documents,
    hydrate: () => getMobileSpaceStructure(resolved.environmentId).hydrate(),
  });
}

export async function createSpacesReferenceController(environmentId: EnvironmentId) {
  return createMobileSpaceReferenceController({
    environmentId,
    captureSession: async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        spacesEnvironment.captureSession,
        { environmentId, input: undefined },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      return result.value;
    },
    access: () => {
      const access = liveAccess(environmentId);
      return {
        sourceVersion: appAtomRegistry.get(spacesEnvironment.changed(environmentId)),
        canRead: canBrowseSpaces(access.availability) && access.current(),
        capability: access.capability,
      };
    },
    search: async (input) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        spacesEnvironment.search,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      return result.value;
    },
    resolve: async (input) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        spacesEnvironment.resolve,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      return result.value;
    },
  });
}

export function useSpacesReferenceController(environmentId: EnvironmentId, attempt = 0) {
  const access = useSpacesReadAccess(environmentId);
  const sourceVersion = useAtomValue(spacesEnvironment.changed(environmentId));
  const stamp = useMemo(
    () => ({ environmentId, access, sourceVersion, attempt }),
    [environmentId, access, sourceVersion, attempt],
  );
  const [state, setState] = useState<{
    stamp: typeof stamp;
    owner: SpaceReferenceController;
  } | null>(null);
  // oxlint-disable-next-line t2code/react-effect-budget -- Own source queries by connection, grant and actual Spaces change generations; never remount the durable document.
  useEffect(() => {
    if (!access.current() || !canBrowseSpaces(access.availability)) return;
    let active = true;
    let owner: SpaceReferenceController | undefined;
    void createSpacesReferenceController(environmentId).then(
      (created) => {
        if (
          !active ||
          !access.current() ||
          appAtomRegistry.get(spacesEnvironment.changed(environmentId)) !== sourceVersion
        ) {
          created.dispose();
          return;
        }
        owner = created;
        setState({ stamp, owner });
      },
      () => {},
    );
    return () => {
      active = false;
      owner?.dispose();
    };
  }, [stamp, environmentId, access, sourceVersion]);
  return state?.stamp === stamp ? state.owner : null;
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
