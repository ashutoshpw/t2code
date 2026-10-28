import * as Schema from "effect/Schema";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceBlockId, SpaceId, SpacePageId } from "@t2code/contracts/spaces";

export const SpacePageNavigationTarget = Schema.Struct({
  environmentId: EnvironmentId,
  spaceId: SpaceId,
  pageId: SpacePageId,
  blockId: Schema.optionalKey(SpaceBlockId),
});
export type SpacePageNavigationTarget = typeof SpacePageNavigationTarget.Type;

export function spacePageSurfaceId(
  target: Pick<SpacePageNavigationTarget, "environmentId" | "pageId">,
) {
  return `space-page:${JSON.stringify([target.environmentId, target.pageId])}` as const;
}

export function validateSpacePageSearch(raw: Record<string, unknown>): { block?: SpaceBlockId } {
  return typeof raw.block === "string" && raw.block.length > 0 && raw.block.length <= 256
    ? { block: SpaceBlockId.make(raw.block) }
    : {};
}
