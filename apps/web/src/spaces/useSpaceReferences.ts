import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useRef, useState } from "react";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { environmentCatalog } from "../connection/catalog";
import * as Cause from "effect/Cause";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t2code/contracts";
import { SpaceReferenceController, type SpaceSearchWindow } from "@t2code/client-runtime/spaces";
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
    environment?.serverConfig?.environment.capabilities.inlineMessageContext,
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
          inlineContext: registry.get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment.capabilities.inlineMessageContext === true,
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

export function useSpaceContextSearch(environmentId: EnvironmentId, query: string | null) {
  const controller = useSpaceReferenceController(environmentId);
  const canCapture = controller?.canCapture() === true;
  const [state, setState] = useState<{
    controller: SpaceReferenceController;
    query: string;
    window: SpaceSearchWindow;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const requestGeneration = useRef(0);
  // oxlint-disable-next-line t2code/react-effect-budget -- synchronize the active composer query with the bounded storage search controller.
  useEffect(() => {
    let active = true;
    const generation = ++requestGeneration.current;
    if (!controller || !canCapture || query === null) return;
    void controller.search(query).then((window) => {
      if (active && requestGeneration.current === generation) {
        setState({ controller, query, window });
        setLoading(false);
      }
    });
    return () => {
      active = false;
      requestGeneration.current++;
      controller.invalidate();
    };
  }, [controller, query, canCapture]);
  const window: SpaceSearchWindow | null =
    controller && !canCapture ? { status: "unsupported" } :
    controller && state?.controller === controller && state.query === query ? state.window : null;
  const retry = async () => {
    if (!controller || !canCapture || query === null) return;
    setLoading(true);
    const generation = ++requestGeneration.current;
    const result = await controller.search(query);
    if (generation !== requestGeneration.current) return;
    setState({ controller, query, window: result });
    setLoading(false);
  };
  const next = async () => {
    if (!controller || query === null || window?.status !== "ready" || !window.current()) return;
    setLoading(true);
    const generation = ++requestGeneration.current;
    const nextWindow = await window.next();
    if (generation !== requestGeneration.current) return;
    setState({ controller, query, window: nextWindow });
    setLoading(false);
  };
  return { window, next, retry, loading: query !== null && !!controller && (loading || !window) };
}
