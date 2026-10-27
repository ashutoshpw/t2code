import {
  SpaceRootReorder,
  checkSpaceStructureDrafts,
  createSpaceServiceSessionAdapter,
} from "@t2code/client-runtime/spaces";
import { canBrowseSpaces, spacesAvailability } from "@t2code/client-runtime/state/spaces";
import { executeAtomQuery, type AtomCommandResult } from "@t2code/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t2code/contracts";
import type { SpaceDraftStore } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageTarget } from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "../state/presentation";
import { environmentSession, sessionHasScope } from "../state/session";
import { spacesEnvironment } from "../state/spaces";
import { randomUUID } from "../lib/utils";
import { createSpaceStructureStore } from "./structureDraftStore";
import { createSpaceDraftStore } from "./draftStore";
import { SpaceDocumentController, SpaceDocumentControllers } from "./documentController";

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  throw Cause.squash(result.cause);
}
const draftStores = new WeakMap<AtomRegistry.AtomRegistry, SpaceDraftStore>();
const structures = new WeakMap<AtomRegistry.AtomRegistry, Map<EnvironmentId, SpaceRootReorder>>();
const registries = new WeakMap<AtomRegistry.AtomRegistry, SpaceDocumentControllers>();

export function spaceDocuments(registry: AtomRegistry.AtomRegistry): SpaceDocumentControllers {
  let documents = registries.get(registry);
  if (documents) return documents;
  const drafts = createSpaceDraftStore();
  draftStores.set(registry, drafts);
  documents = new SpaceDocumentControllers((key: SpacePageTarget) => {
    const target = { environmentId: key.environmentId, input: key };
    function connectionKey() {
      const state = Option.getOrNull(
        AsyncResult.value(registry.get(environmentCatalog.stateAtom(key.environmentId))),
      );
      if (!state || state.phase !== "connected")
        throw new Error("Spaces connection changed; reload the document");
      return `${state.generation}:${state.attempt}`;
    }
    function checkConnection(previous: string) {
      access();
      if (connectionKey() !== previous)
        throw new Error("Spaces connection changed; reload the document");
    }
    function access(write = false) {
      const environment = registry.get(
        environmentPresentations.presentationAtom(key.environmentId),
      );
      const session = registry.get(environmentSession.sessionStateAtom(key.environmentId));
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
    }
    const getPage = async () => {
      access();
      const connection = connectionKey();
      const result = unwrap(
        await executeAtomQuery(registry, spacesEnvironment.page(target), {
          refresh: true,
          reportFailure: false,
        }),
      );
      checkConnection(connection);
      return result;
    };
    const invalidate = () => {
      registry.update(spacesEnvironment.changed(key.environmentId), (value) => value + 1);
    };
    const adapter = createSpaceServiceSessionAdapter(key, {
      getPage,
      limits: () => access(true),
      applyBlockBatch: async (input) => {
        access(true);
        const result = unwrap(
          await spacesEnvironment.apply.run(registry, { environmentId: key.environmentId, input }),
        );
        invalidate();
        return result;
      },
      lookupMutationReceipt: async (input) => {
        access();
        const connection = connectionKey();
        const result = unwrap(
          await executeAtomQuery(
            registry,
            spacesEnvironment.receipt({ environmentId: key.environmentId, input }),
            { refresh: true, reportFailure: false },
          ),
        );
        checkConnection(connection);
        if (result.status === "found") invalidate();
        return result;
      },
    });
    return new SpaceDocumentController(
      key,
      {
        adapter,
        assertMutable: () => spaceRootReorder(registry, key.environmentId).assertReady(),
        drafts,
        createMutationId: randomUUID,
        maxLoadedBlocks: 100,
        maxMutations: 100,
      },
      {
        beforeRead: () => spaceRootReorder(registry, key.environmentId).hydrate(),
        getPage,
        windowLimit: () => access().maxBlockWindowBlocks,
        readBlocks: async (input) => {
          access();
          const connection = connectionKey();
          const result = unwrap(
            await executeAtomQuery(
              registry,
              spacesEnvironment.blocks({ environmentId: key.environmentId, input }),
              { refresh: true, reportFailure: false },
            ),
          );
          checkConnection(connection);
          return result;
        },
      },
    );
  });
  registries.set(registry, documents);
  return documents;
}

export function spaceRootReorder(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): SpaceRootReorder {
  const documents = spaceDocuments(registry);
  let entries = structures.get(registry);
  if (!entries) {
    entries = new Map();
    structures.set(registry, entries);
  }
  const existing = entries.get(environmentId);
  if (existing) return existing;
  if (entries.size >= 8)
    throw new Error(
      "Eight placement journals are resident in this app session; resolve pending changes and reload to open another environment",
    );
  function access(write: boolean) {
    const environment = registry.get(environmentPresentations.presentationAtom(environmentId));
    const session = registry.get(environmentSession.sessionStateAtom(environmentId));
    const capability = environment?.serverConfig?.environment.capabilities.spaces;
    const availability = spacesAvailability({
      connected: environment?.connection.phase === "connected",
      capability,
      canRead: sessionHasScope(session, AuthOrchestrationReadScope),
      canOperate: sessionHasScope(session, AuthOrchestrationOperateScope),
    });
    if (
      capability?.version !== 2 ||
      !canBrowseSpaces(availability) ||
      (write && availability !== "writable")
    )
      throw new Error(
        "Root placement requires a connected v2 environment and destination permission",
      );
    return capability.limits;
  }
  function connection() {
    access(false);
    const state = Option.getOrNull(
      AsyncResult.value(registry.get(environmentCatalog.stateAtom(environmentId))),
    );
    if (!state || state.phase !== "connected") throw new Error("Spaces connection changed");
    return `${state.generation}:${state.attempt}`;
  }
  async function read<A, E>(query: Atom.Atom<AsyncResult.AsyncResult<A, E>>) {
    const previous = connection();
    const result = unwrap(
      await executeAtomQuery(registry, query, { refresh: true, reportFailure: false }),
    );
    if (connection() !== previous)
      throw new Error("Spaces connection changed; stale placement result ignored");
    return result;
  }
  const reorder = new SpaceRootReorder(environmentId, {
    store: createSpaceStructureStore(),
    newId: randomUUID,
    assertAccess: access,
    maxRows: () => access(false).maxListRows,
    maxMutationBytes: () => access(true).maxMutationBytes,
    getPage: (pageId) =>
      read(spacesEnvironment.page({ environmentId, input: { environmentId, pageId } })),
    spaces: (input) => read(spacesEnvironment.list({ environmentId, input })),
    blocks: (input) =>
      read(
        spacesEnvironment.blocks({
          environmentId,
          input: {
            ...input,
            limit: Math.min(input.limit ?? 100, access(false).maxBlockWindowBlocks),
          },
        }),
      ),
    list: (input) => read(spacesEnvironment.pages({ environmentId, input })),
    inspect: (input) => read(spacesEnvironment.inspect({ environmentId, input })),
    receipt: (input) => read(spacesEnvironment.receipt({ environmentId, input })),
    capability: () =>
      registry.get(environmentPresentations.presentationAtom(environmentId))?.serverConfig
        ?.environment.capabilities.spaces,
    trashList: (input) => read(spacesEnvironment.trash({ environmentId, input })),
    createChild: async (input) => {
      access(true);
      const previous = connection();
      const result = unwrap(
        await spacesEnvironment.createChild.run(registry, { environmentId, input }),
      );
      if (connection() !== previous)
        throw new Error("Spaces connection changed; recover the exact child-creation receipt");
      return result;
    },
    recovery: async (operation, input) => {
      access(true);
      const previous = connection();
      const command =
        operation === "trashPage" ? spacesEnvironment.trashPage : spacesEnvironment.restorePage;
      const result = unwrap(await command.run(registry, { environmentId, input }));
      if (connection() !== previous)
        throw new Error("Spaces connection changed; recover the exact recovery receipt");
      return result;
    },
    moveBlocks: async (input) => {
      access(true);
      const previous = connection();
      const result = unwrap(
        await spacesEnvironment.moveBlocks.run(registry, { environmentId, input }),
      );
      if (connection() !== previous)
        throw new Error("Spaces connection changed; recover the exact block-move receipt");
      return result;
    },
    move: async (input) => {
      access(true);
      const previous = connection();
      const result = unwrap(
        await spacesEnvironment.movePage.run(registry, { environmentId, input }),
      );
      if (connection() !== previous)
        throw new Error("Spaces connection changed; recover the exact placement receipt");
      return result;
    },
    reserve: (pages, restoring) => documents.reserve(environmentId, pages, restoring),
    checkDrafts: (pages) =>
      checkSpaceStructureDrafts(draftStores.get(registry)!, environmentId, pages),
    refresh: (pages) => documents.refreshStructure(environmentId, pages),
    changed: () => registry.update(spacesEnvironment.changed(environmentId), (value) => value + 1),
  });
  entries.set(environmentId, reorder);
  return reorder;
}
