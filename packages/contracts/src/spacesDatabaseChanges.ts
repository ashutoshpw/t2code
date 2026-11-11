import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt } from "./baseSchemas.ts";
import { SpaceDataSourceId, SpaceDatabaseId } from "./spacesDatabases.ts";

// Ids and revisions only: a change signal never carries titles, names, cells or rows.
export const SPACE_DATABASE_CHANGES_MAX_ENTRIES = 256;

export const SpaceDatabaseChangesSubscribeInput = Schema.Struct({
  environmentId: EnvironmentId,
});
export type SpaceDatabaseChangesSubscribeInput = typeof SpaceDatabaseChangesSubscribeInput.Type;

export const SpaceDatabaseChangeEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("resync") }),
  Schema.Struct({
    type: Schema.Literal("changed"),
    dataSources: Schema.Array(
      Schema.Struct({
        id: SpaceDataSourceId,
        databaseId: SpaceDatabaseId,
        schemaRevision: NonNegativeInt,
        dataRevision: NonNegativeInt,
      }),
    ).check(Schema.isMaxLength(SPACE_DATABASE_CHANGES_MAX_ENTRIES)),
    databases: Schema.Array(Schema.Struct({ id: SpaceDatabaseId, revision: NonNegativeInt })).check(
      Schema.isMaxLength(SPACE_DATABASE_CHANGES_MAX_ENTRIES),
    ),
  }),
]);
export type SpaceDatabaseChangeEvent = typeof SpaceDatabaseChangeEvent.Type;
