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
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironment, useEnvironments } from "./environments";
import { useEnvironmentScope, useEnvironmentsWithScope } from "./session";

export const spacesEnvironment = createSpacesEnvironmentAtoms(connectionAtomRuntime);

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
