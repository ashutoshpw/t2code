import type { SpaceCapability } from "@t2code/contracts/spaces";
import { WS_METHODS } from "@t2code/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/reactivity";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

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
  if (input.capability.version !== 1) return "unsupported-version";
  if (!input.canRead) return "denied";
  return input.canOperate ? "writable" : "read-only";
}

export function canBrowseSpaces(availability: SpacesAvailability) {
  return availability === "read-only" || availability === "writable";
}

export function createSpacesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:spaces:list",
      tag: WS_METHODS.spacesList,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    pages: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:spaces:pages",
      tag: WS_METHODS.spacesPagesList,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    page: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:spaces:page",
      tag: WS_METHODS.spacesPagesGet,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
  };
}
