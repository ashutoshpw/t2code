import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt } from "./baseSchemas.ts";
import { SpaceId, SpacePageId } from "./spacesCore.ts";

export const SPACE_PAGE_CHANGES_MAX_ENTRIES = 256;

export const SpacePageChangesSubscribeInput = Schema.Struct({ environmentId: EnvironmentId });
export type SpacePageChangesSubscribeInput = typeof SpacePageChangesSubscribeInput.Type;

// Ids and revisions only: a change signal never carries titles, text or blocks.
export const SpacePageChange = Schema.Struct({
  id: SpacePageId,
  spaceId: SpaceId,
  revision: NonNegativeInt,
  bodyRevision: NonNegativeInt,
  /** Title, icon, placement, trash or creation changed: page trees and lists must refresh. */
  tree: Schema.optionalKey(Schema.Literal(true)),
  /** Permanently deleted; revisions are 0. */
  removed: Schema.optionalKey(Schema.Literal(true)),
});
export type SpacePageChange = typeof SpacePageChange.Type;

export const SpacePageChangeEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("resync") }),
  Schema.Struct({
    type: Schema.Literal("changed"),
    pages: Schema.Array(SpacePageChange).check(Schema.isMaxLength(SPACE_PAGE_CHANGES_MAX_ENTRIES)),
    /** Spaces whose own record changed (created, renamed, default). */
    spaces: Schema.Array(SpaceId).check(Schema.isMaxLength(SPACE_PAGE_CHANGES_MAX_ENTRIES)),
  }),
]);
export type SpacePageChangeEvent = typeof SpacePageChangeEvent.Type;
