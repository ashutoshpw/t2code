import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
} from "@t2code/contracts";
import {
  canBrowseSpaces,
  createSpacesEnvironmentAtoms,
  spacesAvailability,
} from "@t2code/client-runtime/state/spaces";
import { createSpacePageNavigationFactory } from "@t2code/client-runtime/spaces";
import { Atom } from "effect/reactivity";
import { environmentPresentations } from "./presentation";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironment, useEnvironments } from "./environments";
import { useEnvironmentScope, useEnvironmentsWithScope } from "./session";

export const spacesEnvironment = createSpacesEnvironmentAtoms(connectionAtomRuntime, {
  capabilityAtom: Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) =>
        get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
          .capabilities.spaces,
    ),
  ),
});
export const spacePageNavigation = createSpacePageNavigationFactory({
  registry: appAtomRegistry,
  pages: spacesEnvironment.pages,
});

export function useSpacesAvailability(environmentId: EnvironmentId | null) {
  const environment = useEnvironment(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  return spacesAvailability({
    connected: environment?.connection.phase === "connected",
    capability: environment?.serverConfig?.environment.capabilities.spaces,
    canRead,
    canOperate,
  });
}

export function useSpacesEnvironments() {
  const { environments } = useEnvironments();
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  return environments.filter((environment) =>
    canBrowseSpaces(
      spacesAvailability({
        connected: environment.connection.phase === "connected",
        capability: environment.serverConfig?.environment.capabilities.spaces,
        canRead: readable.has(environment.environmentId),
        canOperate: false,
      }),
    ),
  );
}
