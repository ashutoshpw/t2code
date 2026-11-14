import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt } from "./baseSchemas.ts";
import {
  SpaceBlockId,
  SpaceId,
  SpacePageIcon,
  SpacePageId,
  mutationAck,
  mutationInput,
} from "./spacesCore.ts";

export const SPACE_SYNCED_REFS_LISTED = 20;
export const SPACE_UNSYNC_MAX_REFS = 64;

export const SpaceReadSubtreeInput = Schema.Struct({
  environmentId: EnvironmentId,
  blockId: SpaceBlockId,
});
export type SpaceReadSubtreeInput = typeof SpaceReadSubtreeInput.Type;

export const SpaceSyncedRefSummary = Schema.Struct({
  blockId: SpaceBlockId,
  pageId: SpacePageId,
  spaceId: SpaceId,
  title: Schema.String,
  icon: Schema.optionalKey(SpacePageIcon),
});
export type SpaceSyncedRefSummary = typeof SpaceSyncedRefSummary.Type;

export const SpaceUnsyncInput = Schema.Struct({
  ...mutationInput,
  sourceBlockId: SpaceBlockId,
  /** Absent: every live copy. */
  refBlockIds: Schema.optionalKey(
    Schema.Array(SpaceBlockId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(SPACE_UNSYNC_MAX_REFS),
    ),
  ),
});
export type SpaceUnsyncInput = typeof SpaceUnsyncInput.Type;

export const SpaceUnsyncResult = Schema.Struct({
  status: Schema.Literal("saved"),
  ...mutationAck,
  pages: Schema.Array(Schema.Struct({ pageId: SpacePageId, revision: NonNegativeInt })),
});
export type SpaceUnsyncResult = typeof SpaceUnsyncResult.Type;
