import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { EnvironmentId, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { SpaceLimits, SpaceSearchLimits } from "./spacesCapability.ts";
import { SpaceMutationId, SpaceReceiptEpoch, StableId } from "./spacesCore.ts";
import { SpaceDatabaseError } from "./spacesDatabaseMutations.ts";
import { SpaceDatabaseLimits } from "./spacesDatabases.ts";

export class SpacesDisabledError extends Schema.TaggedError<SpacesDisabledError>()(
  "SpacesDisabledError",
  {},
) {
  override get message(): string {
    return "Spaces is disabled.";
  }
}
export class SpacesUnavailableError extends Schema.TaggedError<SpacesUnavailableError>()(
  "SpacesUnavailableError",
  { stage: Schema.Literals(["initializing", "storage", "settings", "capacity"]) },
) {
  override get message(): string {
    return "Spaces is unavailable.";
  }
}
export class SpaceEnvironmentMismatchError extends Schema.TaggedError<SpaceEnvironmentMismatchError>()(
  "SpaceEnvironmentMismatchError",
  { environmentId: EnvironmentId },
) {
  override get message(): string {
    return "The Spaces environment does not match.";
  }
}
export class SpaceNotFoundError extends Schema.TaggedError<SpaceNotFoundError>()(
  "SpaceNotFoundError",
  {
    entity: Schema.Literals([
      "space",
      "page",
      "block",
      "database",
      "data_source",
      "view",
      "property",
      "option",
    ]),
    id: StableId,
  },
) {
  override get message(): string {
    return "The Spaces item was not found.";
  }
}
export class SpaceValidationError extends Schema.TaggedError<SpaceValidationError>()(
  "SpaceValidationError",
  {
    reason: Schema.Literals([
      "invalid_cursor",
      "invalid_order",
      "duplicate_id",
      "invalid_parent",
      "cycle",
      "unsupported_block",
      "invalid_merge",
      "trashed",
      "invalid_recovery_state",
      "invalid_input",
      "invalid_search_query",
    ]),
  },
) {
  override get message(): string {
    return "The Spaces request is invalid.";
  }
}
export class SpaceLimitExceededError extends Schema.TaggedError<SpaceLimitExceededError>()(
  "SpaceLimitExceededError",
  {
    limit: Schema.Literals([
      ...Struct.keys(SpaceLimits.fields).filter(
        (key) => key !== "history" && key !== "search" && key !== "assets" && key !== "databases",
      ),
      ...Struct.keys(SpaceSearchLimits.fields).map((key) => `search.${key}` as const),
      ...Struct.keys(SpaceDatabaseLimits.fields).map((key) => `databases.${key}` as const),
      "history.maxDeltaBytes",
      "history.maxPageBytes",
      "history.maxEnvironmentBytes",
    ]),
    actual: NonNegativeInt,
    maximum: PositiveInt,
  },
) {
  override get message(): string {
    return `The Spaces request exceeds ${this.limit}.`;
  }
}
export class SpaceMutationIdMismatchError extends Schema.TaggedError<SpaceMutationIdMismatchError>()(
  "SpaceMutationIdMismatchError",
  { mutationId: SpaceMutationId },
) {
  override get message(): string {
    return "The Spaces mutation ID belongs to a different request.";
  }
}
export class SpaceMutationAdmissionError extends Schema.TaggedError<SpaceMutationAdmissionError>()(
  "SpaceMutationAdmissionError",
  { receiptEpoch: SpaceReceiptEpoch },
) {
  override get message(): string {
    return "The Spaces mutation admission has expired or is unknown.";
  }
}
export class SpaceCursorStaleError extends Schema.TaggedError<SpaceCursorStaleError>()(
  "SpaceCursorStaleError",
  { revision: NonNegativeInt },
) {
  override get message(): string {
    return "The Spaces cursor is stale.";
  }
}
export class SpaceSearchUnavailableError extends Schema.TaggedError<SpaceSearchUnavailableError>()(
  "SpaceSearchUnavailableError",
  { reason: Schema.Literals(["building", "unsupported", "storage"]) },
) {
  override get message(): string {
    return "Spaces search is unavailable.";
  }
}
export class SpaceAssetError extends Schema.TaggedError<SpaceAssetError>()("SpaceAssetError", {
  reason: Schema.Literals([
    "invalid_input",
    "invalid_reservation",
    "intent_mismatch",
    "not_found",
    "caller_mismatch",
    "expired",
    "already_claimed",
    "stale_attempt",
    "quota",
    "pending_limit",
    "active_limit",
    "blob_unavailable",
    "staging_exists",
    "size_mismatch",
    "unsupported_content",
    "media_mismatch",
    "image_dimensions",
    "image_pixels",
    "source_failed",
    "staging_changed",
    "destination_conflict",
    "publication_failed",
    "io_failed",
    "invalid_state",
    "missing_file",
    "corrupt_file",
    "staging_present",
    "not_ready",
    "invalid_token",
    "invalid_content_length",
  ]),
}) {
  override get message(): string {
    return "The Spaces asset request could not be completed.";
  }
}
export const SpaceServiceError = Schema.Union([
  SpaceAssetError,
  SpaceSearchUnavailableError,
  SpacesDisabledError,
  SpacesUnavailableError,
  SpaceEnvironmentMismatchError,
  SpaceNotFoundError,
  SpaceValidationError,
  SpaceLimitExceededError,
  SpaceMutationIdMismatchError,
  SpaceMutationAdmissionError,
  SpaceCursorStaleError,
  SpaceDatabaseError,
]);
export type SpaceServiceError = typeof SpaceServiceError.Type;
