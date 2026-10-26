import type { SpaceCapability } from "@t2code/contracts/spaces";
import { WS_METHODS } from "@t2code/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/reactivity";
import { readSpacePageLocation } from "../spaces/pageLocation.ts";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageId } from "@t2code/contracts/spaces";
import { request } from "../rpc/client.ts";
import {
  createEnvironmentQueryAtomFamily,
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
  return {
    location: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:spaces:location",
      idleTtlMs: 0,
      staleTimeMs: 0,
      execute: (input: { environmentId: EnvironmentId; pageId: SpacePageId; version: 1 | 2 }) =>
        readSpacePageLocation(input, (pageId) =>
          request(WS_METHODS.spacesPagesGet, { environmentId: input.environmentId, pageId }),
        ),
    }),
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
