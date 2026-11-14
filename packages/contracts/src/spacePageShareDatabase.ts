import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { SPACE_PAGE_SHARE_ROUTE_PREFIX, SpaceSharedPageRef } from "./spacePageShare.ts";
import {
  SpaceAssetId,
  SpaceBlockWindow,
  SpaceCellMap,
  SpaceCursor,
  SpaceDataSourceId,
  SpaceDatabaseId,
  SpaceDatabaseProperty,
  SpaceGroupKey,
  SpaceOptionId,
  SpacePageIcon,
  SpacePageId,
  SpacePropertyId,
  SpaceRelatedPage,
  SpaceViewId,
} from "./spaces.ts";

/**
 * Databases on a shared page, read only. Every shape here is built key by key on the server from
 * an allow-list; nothing the signed-in database wire carries (filters, sorts, hidden properties,
 * revisions, admission) is part of it. Routes take the share credential in the page share header.
 */
export const SPACE_PAGE_SHARE_DATABASE_ROUTE = `${SPACE_PAGE_SHARE_ROUTE_PREFIX}/database`;
export const SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE = `${SPACE_PAGE_SHARE_ROUTE_PREFIX}/database/query`;
export const SPACE_PAGE_SHARE_DATABASE_ROW_ROUTE = `${SPACE_PAGE_SHARE_ROUTE_PREFIX}/database/row`;
export const SPACE_PAGE_SHARE_BLOCK_PARAM = "block";
export const SPACE_PAGE_SHARE_VIEW_PARAM = "view";
export const SPACE_PAGE_SHARE_ROW_PARAM = "row";
export const SPACE_PAGE_SHARE_GROUP_PARAM = "group";
export const SPACE_PAGE_SHARE_FROM_PARAM = "from";
export const SPACE_PAGE_SHARE_TO_PARAM = "to";
export const SPACE_PAGE_SHARE_ZONE_PARAM = "tz";
export const SPACE_SHARED_DATABASE_WINDOW_ROWS = 50;
export const SPACE_SHARED_DATABASE_GROUP_ROWS = 10;
export const SPACE_SHARED_DATABASE_RANGE_DAYS = 92;

const optional = Schema.optionalKey;

export const SpaceSharedDatabaseView = Schema.Struct({
  id: SpaceViewId,
  dataSourceId: SpaceDataSourceId,
  name: Schema.String,
  type: Schema.String,
  /** The visible columns after the title, in view order. */
  properties: Schema.Array(
    Schema.Struct({
      propertyId: SpacePropertyId,
      width: optional(PositiveInt),
      wrap: optional(Schema.Boolean),
    }),
  ),
  layout: Schema.Json,
  group: optional(
    Schema.Struct({
      property: SpacePropertyId,
      by: optional(Schema.Json),
      sort: optional(Schema.String),
      order: optional(Schema.Array(SpaceGroupKey)),
      hideEmpty: optional(Schema.Boolean),
    }),
  ),
});
export type SpaceSharedDatabaseView = typeof SpaceSharedDatabaseView.Type;

export const SpaceSharedDataSource = Schema.Struct({
  id: SpaceDataSourceId,
  name: Schema.String,
  properties: Schema.Record(Schema.String, SpaceDatabaseProperty),
});
export type SpaceSharedDataSource = typeof SpaceSharedDataSource.Type;

export const SpaceSharedDatabase = Schema.Struct({
  database: Schema.Struct({
    id: SpaceDatabaseId,
    title: Schema.String,
    icon: optional(SpacePageIcon),
  }),
  dataSources: Schema.Array(SpaceSharedDataSource),
  views: Schema.Array(SpaceSharedDatabaseView),
});
export type SpaceSharedDatabase = typeof SpaceSharedDatabase.Type;

export const SpaceSharedOption = Schema.Struct({
  id: SpaceOptionId,
  name: Schema.String,
  color: Schema.String,
  group: optional(Schema.String),
});
export type SpaceSharedOption = typeof SpaceSharedOption.Type;

export const SpaceSharedDatabaseRow = Schema.Struct({
  id: SpacePageId,
  title: Schema.String,
  icon: optional(SpacePageIcon),
  cells: SpaceCellMap,
  cover: optional(Schema.Struct({ assetId: SpaceAssetId })),
});
export type SpaceSharedDatabaseRow = typeof SpaceSharedDatabaseRow.Type;

export const SpaceSharedGroupBucket = Schema.Struct({
  key: SpaceGroupKey,
  label: optional(Schema.String),
  count: NonNegativeInt,
  rows: Schema.Array(SpaceSharedDatabaseRow),
  nextCursor: Schema.NullOr(Schema.String),
  /** Chart views: the y aggregate of this bucket. */
  aggregates: optional(
    Schema.Array(
      Schema.Struct({
        property: SpacePropertyId,
        function: Schema.String,
        number: optional(Schema.Number),
      }),
    ),
  ),
});
export type SpaceSharedGroupBucket = typeof SpaceSharedGroupBucket.Type;

const relatedPages = Schema.Record(Schema.String, SpaceRelatedPage);
const options = Schema.Record(Schema.String, Schema.Array(SpaceSharedOption));

export const SpaceSharedDatabaseWindow = Schema.Struct({
  rows: Schema.Array(SpaceSharedDatabaseRow),
  groups: optional(Schema.Array(SpaceSharedGroupBucket)),
  groupsTruncated: optional(Schema.Boolean),
  relatedPages,
  options,
  nextCursor: Schema.NullOr(Schema.String),
});
export type SpaceSharedDatabaseWindow = typeof SpaceSharedDatabaseWindow.Type;

export const SpaceSharedDatabaseRowPage = Schema.Struct({
  row: SpaceSharedDatabaseRow,
  relatedPages,
  options,
  /** One window of the row's body blocks. */
  window: SpaceBlockWindow,
  nextCursor: optional(SpaceCursor),
  /** The host page's breadcrumb, then the row. */
  breadcrumb: Schema.Array(SpaceSharedPageRef),
});
export type SpaceSharedDatabaseRowPage = typeof SpaceSharedDatabaseRowPage.Type;
