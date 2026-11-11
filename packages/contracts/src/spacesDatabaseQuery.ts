import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { SpaceCursor, SpaceId, SpaceMutationAdmission, SpacePageId } from "./spacesCore.ts";
import {
  SpaceAggregate,
  SpaceAggregateResult,
  SpaceFilter,
  SpaceGroup,
  SpaceGroupKey,
  SpaceSort,
} from "./spacesDatabaseFilters.ts";
import { SpaceDatabaseView } from "./spacesDatabaseViews.ts";
import {
  SpaceDataSource,
  SpaceDataSourceId,
  SpaceDatabase,
  SpaceDatabaseId,
  SpaceDatabaseRow,
  SpacePropertyId,
  SpaceRelatedPage,
  SpaceViewId,
} from "./spacesDatabases.ts";

const optional = Schema.optionalKey;

export const SpaceDatabaseGetInput = Schema.Struct({
  environmentId: EnvironmentId,
  databaseId: SpaceDatabaseId,
});
export type SpaceDatabaseGetInput = typeof SpaceDatabaseGetInput.Type;
export const SpaceDatabaseGetResult = Schema.Struct({
  database: SpaceDatabase,
  dataSources: Schema.Array(SpaceDataSource),
  views: Schema.Array(SpaceDatabaseView),
  mutationAdmission: SpaceMutationAdmission,
});
export type SpaceDatabaseGetResult = typeof SpaceDatabaseGetResult.Type;

export const SpaceDatabaseListInput = Schema.Struct({
  environmentId: EnvironmentId,
  spaceId: optional(SpaceId),
  cursor: optional(SpaceCursor),
  limit: optional(PositiveInt),
});
export type SpaceDatabaseListInput = typeof SpaceDatabaseListInput.Type;
export const SpaceDatabaseListResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      database: SpaceDatabase,
      dataSources: Schema.Array(Schema.Struct({ id: SpaceDataSourceId, name: Schema.String })),
    }),
  ),
  nextCursor: Schema.NullOr(SpaceCursor),
  mutationAdmission: SpaceMutationAdmission,
});
export type SpaceDatabaseListResult = typeof SpaceDatabaseListResult.Type;

const relatedPages = Schema.Record(Schema.String, SpaceRelatedPage);
export const SpaceDatabaseRowGetInput = Schema.Struct({
  environmentId: EnvironmentId,
  pageId: SpacePageId,
  properties: optional(Schema.Array(SpacePropertyId)),
  /** IANA zone for volatile formulas (now, today); defaults to the server's. */
  timeZone: optional(Schema.String),
});
export type SpaceDatabaseRowGetInput = typeof SpaceDatabaseRowGetInput.Type;
export const SpaceDatabaseRowGetResult = Schema.Struct({
  row: SpaceDatabaseRow,
  template: Schema.Boolean,
  dataSource: Schema.Struct({
    id: SpaceDataSourceId,
    databaseId: SpaceDatabaseId,
    schemaRevision: NonNegativeInt,
    dataRevision: NonNegativeInt,
  }),
  relatedPages,
  /** Computed values of this data source are still being brought up to date. */
  computedPending: optional(Schema.Boolean),
  mutationAdmission: SpaceMutationAdmission,
});
export type SpaceDatabaseRowGetResult = typeof SpaceDatabaseRowGetResult.Type;

export const SpaceDatabaseQueryInput = Schema.Struct({
  environmentId: EnvironmentId,
  dataSourceId: SpaceDataSourceId,
  /** Base definition; must be a view of dataSourceId. */
  viewId: optional(SpaceViewId),
  /** Present replaces the view's filter; null removes it. */
  filter: optional(Schema.NullOr(SpaceFilter)),
  /** ANDed with the effective filter (quick filters). */
  extraFilter: optional(SpaceFilter),
  sorts: optional(Schema.Array(SpaceSort)),
  group: optional(Schema.NullOr(SpaceGroup)),
  subGroup: optional(Schema.NullOr(SpaceGroup)),
  /** Title contains, folded. */
  search: optional(Schema.String),
  mode: Schema.Literals(["rows", "groups"]),
  scope: optional(
    Schema.Struct({
      group: optional(SpaceGroupKey),
      subGroup: optional(SpaceGroupKey),
      /** Sub-items: null is top-level rows, an id is the children of that row. */
      parentRowId: optional(Schema.NullOr(SpacePageId)),
    }),
  ),
  /** Cells to return. */
  properties: optional(Schema.Array(SpacePropertyId)),
  /** Present replaces the view's column aggregates. */
  aggregates: optional(Schema.Array(SpaceAggregate)),
  include: optional(
    Schema.Struct({
      total: optional(Schema.Boolean),
      aggregates: optional(Schema.Boolean),
      cover: optional(Schema.Boolean),
    }),
  ),
  /** Groups mode; default 0. */
  rowsPerGroup: optional(NonNegativeInt),
  limit: optional(PositiveInt),
  cursor: optional(SpaceCursor),
  /** IANA zone of the viewer. */
  timeZone: Schema.String,
  weekStart: optional(Schema.Literals(["sunday", "monday"])),
});
export type SpaceDatabaseQueryInput = typeof SpaceDatabaseQueryInput.Type;

const groupBucketBase = {
  key: SpaceGroupKey,
  label: optional(Schema.String),
  count: NonNegativeInt,
  aggregates: optional(Schema.Array(SpaceAggregateResult)),
  rows: Schema.Array(SpaceDatabaseRow),
  /** Continue this bucket with mode "rows" and scope.group. */
  nextCursor: Schema.NullOr(SpaceCursor),
};
export const SpaceGroupBucket = Schema.Struct({
  ...groupBucketBase,
  subGroups: optional(Schema.Array(Schema.Struct(groupBucketBase))),
});
export type SpaceGroupBucket = typeof SpaceGroupBucket.Type;

export const SpaceDatabaseQueryResult = Schema.Struct({
  dataSourceId: SpaceDataSourceId,
  schemaRevision: NonNegativeInt,
  dataRevision: NonNegativeInt,
  /** Empty in groups mode. */
  rows: Schema.Array(SpaceDatabaseRow),
  groups: optional(Schema.Array(SpaceGroupBucket)),
  groupsTruncated: optional(Schema.Boolean),
  total: optional(NonNegativeInt),
  aggregates: optional(Schema.Array(SpaceAggregateResult)),
  relatedPages,
  /** Some computed values of this data source are still being brought up to date; ask again. */
  computedPending: optional(Schema.Boolean),
  /** Rows mode only. */
  nextCursor: Schema.NullOr(SpaceCursor),
});
export type SpaceDatabaseQueryResult = typeof SpaceDatabaseQueryResult.Type;
