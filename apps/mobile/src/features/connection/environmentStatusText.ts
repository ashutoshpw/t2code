import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t2code/client-runtime/connection";

export function environmentStatusText(connection: EnvironmentConnectionPresentation): string {
  return connection.phase === "unsupported" && connection.error !== null
    ? connection.error
    : connectionStatusText(connection);
}
