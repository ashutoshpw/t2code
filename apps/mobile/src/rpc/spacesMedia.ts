import { WS_METHODS, type EnvironmentId } from "@t2code/contracts";
import type { SpaceAssetId } from "@t2code/contracts/spaces";
import type { EnvironmentRegistry } from "@t2code/client-runtime/connection";
import { executeScopedEnvironmentRpc } from "@t2code/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import type { Atom, AtomRegistry } from "effect/reactivity";

export function createSpacesMediaReads<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  assertRead: () => void,
) {
  const options = (signal: AbortSignal) => ({
    signal,
    assertCurrent: assertRead,
    reportFailure: false,
    reportDefect: false,
  });
  return {
    metadata: async (assetId: SpaceAssetId, signal: AbortSignal) => {
      const result = await executeScopedEnvironmentRpc(
        runtime,
        registry,
        WS_METHODS.spacesAssetsGet,
        { environmentId, input: { environmentId, assetId } },
        options(signal),
      );
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      return result.value;
    },
    mint: async (
      assetId: SpaceAssetId,
      disposition: "inline" | "attachment",
      signal: AbortSignal,
    ) => {
      const result = await executeScopedEnvironmentRpc(
        runtime,
        registry,
        WS_METHODS.assetsCreateUrl,
        {
          environmentId,
          input: { resource: { _tag: "spaces-asset", environmentId, assetId, disposition } },
        },
        options(signal),
      );
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      return result.value;
    },
  };
}
