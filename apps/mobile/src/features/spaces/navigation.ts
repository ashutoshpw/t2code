import * as Schema from "effect/Schema";
import { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceId } from "@t2code/contracts/spaces";

export const spacesLibraryLinking = { path: "spaces/:environmentId?/:spaceId?" };
export const spacesPageLinking = { path: "spaces/:environmentId/:spaceId/:pageId" };
const decodePage = Schema.decodeUnknownOption(SpacePageNavigationTarget);
const decodeLibrary = Schema.decodeUnknownOption(
  Schema.Struct({
    environmentId: Schema.optionalKey(EnvironmentId),
    spaceId: Schema.optionalKey(SpaceId),
  }),
);

export function readSpacesLibraryTarget(input: unknown) {
  const result = decodeLibrary(input ?? {});
  if (
    result._tag === "None" ||
    Object.values(result.value).some((value) => new TextEncoder().encode(value).byteLength > 256)
  )
    return null;
  return result.value;
}

export function readSpacesPageTarget(input: unknown): SpacePageNavigationTarget | null {
  if (typeof input !== "object" || input === null) return null;
  const params = input as Record<string, unknown>;
  const candidate = {
    environmentId: params.environmentId,
    spaceId: params.spaceId,
    pageId: params.pageId,
    ...(params.block === undefined ? {} : { blockId: params.block }),
  };
  if (
    Object.values(candidate).some(
      (value) => typeof value !== "string" || new TextEncoder().encode(value).byteLength > 256,
    )
  )
    return null;
  const result = decodePage(candidate);
  return result._tag === "Some" ? result.value : null;
}
