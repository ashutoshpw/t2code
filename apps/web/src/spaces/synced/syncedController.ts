import {
  createSpaceServiceSessionAdapter,
  type SpaceDraftStore,
  type SpaceServicePorts,
} from "@t2code/client-runtime/spaces";
import { canBrowseSpaces, spacesAvailability } from "@t2code/client-runtime/state/spaces";
import { executeAtomQuery } from "@t2code/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t2code/contracts";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceBlockId,
  SpaceLimits,
  SpacePageId,
  SpaceReadSubtreeResult,
} from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession, sessionHasScope } from "../../state/session";
import { spacesEnvironment } from "../../state/spaces";
import { randomUUID } from "../../lib/utils";
import { SpaceDocumentController } from "../documentController";

export type Found = Extract<SpaceReadSubtreeResult, { readonly status: "found" }>;

/** Drafts of a synced copy live in memory: the original's page keeps its own stored draft. */
function memoryDrafts(): SpaceDraftStore {
  const held = new Map<string, Parameters<SpaceDraftStore["write"]>[1]>();
  const idOf = (key: { environmentId: string; pageId: string }) =>
    `${key.environmentId}\n${key.pageId}`;
  return {
    load: (key) => Promise.resolve(held.get(idOf(key)) ?? null),
    write: (key, draft) => {
      if (draft === null) held.delete(idOf(key));
      else held.set(idOf(key), draft);
      return Promise.resolve();
    },
  };
}

interface SyncedSessionPorts {
  readonly readSubtree: () => Promise<Found>;
  readonly applyBlockBatch: SpaceServicePorts["applyBlockBatch"];
  readonly lookupMutationReceipt: SpaceServicePorts["lookupMutationReceipt"];
  readonly limits: (write?: boolean) => SpaceLimits;
  readonly createMutationId: () => string;
}

/**
 * A document session over one synced original: its window is the original and its descendants on
 * the source page, and every save is confined to that subtree. Not registered with the page
 * controllers, so it never collides with the source page's own open document.
 */
export function syncedSession(
  environmentId: EnvironmentId,
  source: { readonly blockId: SpaceBlockId; readonly pageId: SpacePageId },
  ports: SyncedSessionPorts,
) {
  const key = { environmentId, pageId: source.pageId };
  const metadata = async () => {
    const { page, mutationAdmission } = await ports.readSubtree();
    return { page, mutationAdmission };
  };
  return new SpaceDocumentController(
    key,
    {
      adapter: createSpaceServiceSessionAdapter(
        key,
        {
          getPage: metadata,
          limits: () => ports.limits(true),
          applyBlockBatch: ports.applyBlockBatch,
          lookupMutationReceipt: ports.lookupMutationReceipt,
        },
        { subtreeRootId: source.blockId },
      ),
      drafts: memoryDrafts(),
      createMutationId: ports.createMutationId,
      maxLoadedBlocks: 100,
      maxMutations: 100,
    },
    {
      getPage: metadata,
      readBlocks: () => Promise.reject(new Error("A synced window is read as one snapshot")),
      readWindow: async () => {
        const found = await ports.readSubtree();
        return {
          metadata: { page: found.page, mutationAdmission: found.mutationAdmission },
          blocks: { revision: found.revision, blocks: found.blocks, nextCursor: null },
        };
      },
      windowLimit: () => ports.limits().maxBlockWindowBlocks,
    },
  );
}

export function createSyncedController(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  source: { readonly blockId: SpaceBlockId; readonly pageId: SpacePageId },
) {
  const access = (write = false) => {
    const environment = registry.get(environmentPresentations.presentationAtom(environmentId));
    const session = registry.get(environmentSession.sessionStateAtom(environmentId));
    const capability = environment?.serverConfig?.environment.capabilities.spaces;
    const availability = spacesAvailability({
      connected: environment?.connection.phase === "connected",
      capability,
      canRead: sessionHasScope(session, AuthOrchestrationReadScope),
      canOperate: sessionHasScope(session, AuthOrchestrationOperateScope),
    });
    if (!canBrowseSpaces(availability) || (write && availability !== "writable") || !capability)
      throw new Error("Spaces is unavailable for this connection or permission");
    return capability.limits;
  };
  const connectionKey = () => {
    const state = Option.getOrNull(
      AsyncResult.value(registry.get(environmentCatalog.stateAtom(environmentId))),
    );
    if (!state || state.phase !== "connected")
      throw new Error("Spaces connection changed; reload the document");
    return `${state.generation}:${state.attempt}`;
  };
  return syncedSession(environmentId, source, {
    readSubtree: async () => {
      access();
      const connection = connectionKey();
      const result = await executeAtomQuery(
        registry,
        spacesEnvironment.readSubtree({
          environmentId,
          input: { environmentId, blockId: source.blockId },
        }),
        { refresh: true, reportFailure: false },
      );
      if (result._tag !== "Success") throw Cause.squash(result.cause);
      access();
      if (connectionKey() !== connection)
        throw new Error("Spaces connection changed; reload the document");
      if (result.value.status !== "found")
        throw new Error("The original synced block is no longer available");
      return result.value;
    },
    limits: access,
    applyBlockBatch: async (input) => {
      access(true);
      const result = await spacesEnvironment.apply.run(registry, { environmentId, input });
      if (result._tag !== "Success") throw Cause.squash(result.cause);
      registry.update(spacesEnvironment.changed(environmentId), (value) => value + 1);
      return result.value;
    },
    lookupMutationReceipt: async (input) => {
      access();
      const result = await executeAtomQuery(
        registry,
        spacesEnvironment.receipt({ environmentId, input }),
        { refresh: true, reportFailure: false },
      );
      if (result._tag !== "Success") throw Cause.squash(result.cause);
      return result.value;
    },
    createMutationId: randomUUID,
  });
}
