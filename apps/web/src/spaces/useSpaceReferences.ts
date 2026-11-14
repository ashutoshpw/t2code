import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useState } from "react";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { environmentCatalog } from "../connection/catalog";
import * as Cause from "effect/Cause";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t2code/contracts";
import { SpaceReferenceController } from "@t2code/client-runtime/spaces";
import { runAtomCommand } from "@t2code/client-runtime/state/runtime";
import { spacesEnvironment } from "../state/spaces";
import { environmentPresentations } from "../state/presentation";
import { environmentSession, sessionHasScope, useEnvironmentScope } from "../state/session";
import { useEnvironment } from "../state/environments";

export function useSpaceReferenceController(environmentId: EnvironmentId, attempt = 0) {
  const registry = useContext(RegistryContext);
  const environment = useEnvironment(environmentId);
  const connection = Option.getOrNull(
    AsyncResult.value(useAtomValue(environmentCatalog.stateAtom(environmentId))),
  );
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const sourceVersion = useAtomValue(spacesEnvironment.changed(environmentId));
  const key = JSON.stringify([
    environmentId,
    attempt,
    sourceVersion,
    connection?.phase,
    connection?.generation,
    connection?.attempt,
    canRead,
    environment?.serverConfig?.environment.capabilities.spaces,
  ]);
  const [owner, setOwner] = useState<{
    key: string;
    registry: typeof registry;
    controller: SpaceReferenceController;
  } | null>(null);
  // oxlint-disable-next-line t2code/react-effect-budget -- Own bounded source reads by the live connection and read-grant generation.
  useEffect(() => {
    let active = true,
      controller: SpaceReferenceController | undefined;
    if (environment?.connection.phase !== "connected" || !canRead) return;
    void runAtomCommand(
      registry,
      spacesEnvironment.captureSession,
      { environmentId, input: undefined },
      { reportFailure: false },
    ).then((result) => {
      if (
        !active ||
        result._tag !== "Success" ||
        registry.get(spacesEnvironment.changed(environmentId)) !== sourceVersion
      )
        return;
      const session = result.value;
      controller = new SpaceReferenceController({
        environmentId,
        access: () => ({
          session: active ? session() : null,
          sourceVersion: registry.get(spacesEnvironment.changed(environmentId)),
          canRead: sessionHasScope(
            registry.get(environmentSession.sessionStateAtom(environmentId)),
            AuthOrchestrationReadScope,
          ),
          capability: registry.get(environmentPresentations.presentationAtom(environmentId))
            ?.serverConfig?.environment.capabilities.spaces,
        }),
        search: async (input) => {
          const result = await runAtomCommand(
            registry,
            spacesEnvironment.search,
            { environmentId, input },
            { reportFailure: false },
          );
          if (result._tag === "Failure") throw Cause.squash(result.cause);
          return result.value;
        },
        resolve: async (input) => {
          const result = await runAtomCommand(
            registry,
            spacesEnvironment.resolve,
            { environmentId, input },
            { reportFailure: false },
          );
          if (result._tag === "Failure") throw Cause.squash(result.cause);
          return result.value;
        },
      });
      setOwner({ key, registry, controller });
    });
    return () => {
      active = false;
      controller?.dispose();
    };
  }, [key, registry, environmentId, canRead, sourceVersion, environment?.connection.phase]);
  return owner?.key === key && owner.registry === registry ? owner.controller : null;
}
