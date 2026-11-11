import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceBlockId,
  SpaceDatabaseId,
  SpaceId,
  SpacePageId,
  SpaceViewId,
} from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";

export const spacesDatabaseLinking = {
  path: "spaces/:environmentId/:spaceId/:pageId/database/:blockId",
};

const MAX_PARAM_BYTES = 256;
const MAX_VIEWS = 100;

const Target = Schema.Struct({
  environmentId: EnvironmentId,
  spaceId: SpaceId,
  pageId: SpacePageId,
  blockId: SpaceBlockId,
  viewId: Schema.optionalKey(SpaceViewId),
  databaseId: Schema.optionalKey(SpaceDatabaseId),
  viewIds: Schema.optionalKey(Schema.Array(SpaceViewId)),
});
const decode = Schema.decodeUnknownOption(Target);

export interface SpacesDatabaseTarget {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  /** The page the database block sits on. */
  readonly pageId: SpacePageId;
  readonly blockId: SpaceBlockId;
  readonly viewId?: SpaceViewId;
  /** Present when the screen was pushed from the block, which already knows them. */
  readonly block?: {
    readonly databaseId: SpaceDatabaseId;
    readonly viewIds: ReadonlyArray<SpaceViewId>;
  };
}

const tooLong = (value: unknown) =>
  typeof value === "string" && new TextEncoder().encode(value).byteLength > MAX_PARAM_BYTES;

/** Route params to a target; null when they are missing, malformed or oversized. */
export function readSpacesDatabaseTarget(input: unknown): SpacesDatabaseTarget | null {
  if (typeof input !== "object" || input === null) return null;
  const params: Record<string, unknown> = Object.fromEntries(Object.entries(input));
  const viewIds = params["viewIds"];
  if (
    Object.values(params).some(tooLong) ||
    (Array.isArray(viewIds) && (viewIds.length > MAX_VIEWS || viewIds.some(tooLong)))
  )
    return null;
  const result = decode(params);
  if (result._tag === "None") return null;
  const { databaseId, viewIds: ids, ...rest } = result.value;
  if ((databaseId === undefined) !== (ids === undefined)) return null;
  return {
    ...rest,
    ...(databaseId === undefined || ids === undefined
      ? {}
      : { block: { databaseId, viewIds: ids } }),
  };
}
