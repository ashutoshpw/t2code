import type { SpaceCapability } from "@t2code/contracts/spaces";
import { WS_METHODS, type EnvironmentId } from "@t2code/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { readSpacePageLocation } from "../spaces/pageLocation.ts";
import type { SpacePageId } from "@t2code/contracts/spaces";
import { request } from "../rpc/client.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export type SpacesAvailability =
  | "disconnected"
  | "unavailable"
  | "unsupported-version"
  | "denied"
  | "read-only"
  | "writable";

export function spacesAvailability(input: {
  readonly connected: boolean;
  readonly capability: Pick<SpaceCapability, "version"> | undefined;
  readonly canRead: boolean;
  readonly canOperate: boolean;
}): SpacesAvailability {
  if (!input.connected) return "disconnected";
  if (!input.capability) return "unavailable";
  if (input.capability.version !== 1 && input.capability.version !== 2)
    return "unsupported-version";
  if (!input.canRead) return "denied";
  return input.canOperate ? "writable" : "read-only";
}

export function canBrowseSpaces(availability: SpacesAvailability) {
  return availability === "read-only" || availability === "writable";
}

export function createSpacesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const changed = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  const refreshTrigger = ({ environmentId }: { environmentId: EnvironmentId }) =>
    changed(environmentId);
  return {
    // Each caller owns this query; sharing its SWR cache could authorize an obsolete location.
    location: (target: {
      environmentId: EnvironmentId;
      input: { environmentId: EnvironmentId; pageId: SpacePageId; version: 1 | 2 };
    }) =>
      createEnvironmentQueryAtomFamily(runtime, {
        label: "environment-data:spaces:location",
        idleTtlMs: 0,
        staleTimeMs: 0,
        execute: Effect.fn("Spaces.readCurrentLocation")(function* (input: {
          environmentId: EnvironmentId;
          pageId: SpacePageId;
          version: 1 | 2;
        }) {
          const supervisor = yield* EnvironmentSupervisor;
          const state = SubscriptionRef.getUnsafe(supervisor.state);
          const session = SubscriptionRef.getUnsafe(supervisor.session);
          const isCurrent = () => {
            const active = SubscriptionRef.getUnsafe(supervisor.session);
            return (
              state.phase === "connected" &&
              SubscriptionRef.getUnsafe(supervisor.state) === state &&
              Option.isSome(session) &&
              Option.isSome(active) &&
              session.value === active.value
            );
          };
          return yield* readSpacePageLocation(input, (pageId) =>
            request(WS_METHODS.spacesPagesGet, { environmentId: input.environmentId, pageId }),
          ).pipe(
            Effect.matchEffect({
              onFailure: (error) => (isCurrent() ? Effect.fail(error) : Effect.never),
              onSuccess: (data) =>
                isCurrent()
                  ? Effect.succeed({ ...data, current: () => (isCurrent() ? data : null) })
                  : Effect.never,
            }),
          );
        }),
      })(target),
    changed,
    blocks: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:spaces:blocks",
      tag: WS_METHODS.spacesBlocksRead,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    receipt: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:spaces:receipt",
      tag: WS_METHODS.spacesReceiptsGet,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    apply: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:apply",
      tag: WS_METHODS.spacesBlocksApply,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      refreshTrigger,
      label: "environment-data:spaces:list",
      tag: WS_METHODS.spacesList,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    pages: createEnvironmentRpcQueryAtomFamily(runtime, {
      refreshTrigger,
      label: "environment-data:spaces:pages",
      tag: WS_METHODS.spacesPagesList,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    page: createEnvironmentRpcQueryAtomFamily(runtime, {
      refreshTrigger,
      label: "environment-data:spaces:page",
      tag: WS_METHODS.spacesPagesGet,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
  };
}
