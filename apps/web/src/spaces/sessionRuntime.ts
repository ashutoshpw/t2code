import { createSpaceServiceSessionAdapter } from "@t2code/client-runtime/spaces";
import { canBrowseSpaces, spacesAvailability } from "@t2code/client-runtime/state/spaces";
import { executeAtomQuery, type AtomCommandResult } from "@t2code/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t2code/contracts";
import type { SpacePageTarget } from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "../state/presentation";
import { environmentSession, sessionHasScope } from "../state/session";
import { spacesEnvironment } from "../state/spaces";
import { randomUUID } from "../lib/utils";
import { createSpaceDraftStore } from "./draftStore";
import { SpaceDocumentController, SpaceDocumentControllers } from "./documentController";

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  throw Cause.squash(result.cause);
}
const registries = new WeakMap<AtomRegistry.AtomRegistry, SpaceDocumentControllers>();

export function spaceDocuments(registry: AtomRegistry.AtomRegistry): SpaceDocumentControllers {
  let documents = registries.get(registry);
  if (documents) return documents;
  const drafts = createSpaceDraftStore();
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
        drafts,
        createMutationId: randomUUID,
        maxLoadedBlocks: 100,
        maxMutations: 100,
      },
      {
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
