import * as Effect from "effect/Effect";

import { environmentEndpointUrl } from "./endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "metadata");
  const timeoutMs = input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS;
  // Servers published before the binary rename only answer on the old path;
  // their router 404s the new one. Other failures report as before.
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/.well-known/t2/environment"),
    timeoutMs,
    client.descriptor(),
  ).pipe(
    Effect.catchIf(
      (cause) =>
        cause._tag === "RemoteEnvironmentAuthUndeclaredStatusError" && cause.status === 404,
      () =>
        executeEnvironmentHttpRequest(
          environmentEndpointUrl(input.httpBaseUrl, "/.well-known/t3/environment"),
          timeoutMs,
          client.descriptorLegacy(),
        ),
    ),
  );
});
