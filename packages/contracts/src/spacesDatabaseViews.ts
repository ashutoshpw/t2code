import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { SpaceBlockId, StableId } from "./spacesCore.ts";
import {
  SPACE_FORM_DESCRIPTION_MAX,
  SPACE_FORM_MAX_QUESTIONS,
  SpaceFormQuestion,
} from "./spacesDatabaseForms.ts";
import {
  SpaceDataSourceId,
  SpaceDatabaseId,
  SpacePropertyId,
  SpaceViewId,
  type SpaceViewType,
} from "./spacesDatabases.ts";
import {
  SpaceAggregateFunction,
  SpaceFilter,
  SpaceGroup,
  SpaceKnownFilter,
  SpaceKnownGroup,
  SpaceKnownSort,
  SpaceSort,
} from "./spacesDatabaseFilters.ts";

const Rest = [Schema.Record(Schema.String, Schema.Json)] as const;

export const SpaceViewProperty = Schema.StructWithRest(
  Schema.Struct({
    propertyId: SpacePropertyId,
    visible: Schema.Boolean,
    /** Pixels. */
    width: Schema.optionalKey(PositiveInt),
    wrap: Schema.optionalKey(Schema.Boolean),
    /** A SpaceAggregateFunction. */
    aggregate: Schema.optionalKey(StableId),
  }),
  Rest,
);
export type SpaceViewProperty = typeof SpaceViewProperty.Type;
export const SpaceKnownViewProperty = Schema.Struct({
  propertyId: SpacePropertyId,
  visible: Schema.Boolean,
  width: Schema.optionalKey(PositiveInt),
  wrap: Schema.optionalKey(Schema.Boolean),
  aggregate: Schema.optionalKey(SpaceAggregateFunction),
});
export type SpaceKnownViewProperty = typeof SpaceKnownViewProperty.Type;

// A live property missing from `properties` is hidden and ordered last by schema position.
export const SpaceDatabaseView = Schema.StructWithRest(
  Schema.Struct({
    id: SpaceViewId,
    databaseId: SpaceDatabaseId,
    dataSourceId: SpaceDataSourceId,
    name: Schema.String,
    type: StableId,
    position: Schema.Int,
    filter: Schema.optionalKey(SpaceFilter),
    sorts: Schema.Array(SpaceSort),
    group: Schema.optionalKey(SpaceGroup),
    subGroup: Schema.optionalKey(SpaceGroup),
    properties: Schema.Array(SpaceViewProperty),
    layout: Schema.Json,
    ownerBlockId: Schema.optionalKey(SpaceBlockId),
  }),
  Rest,
);
export type SpaceDatabaseView = typeof SpaceDatabaseView.Type;

export const SpaceCardPreview = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("page_cover") }),
  Schema.Struct({ kind: Schema.Literal("page_content") }),
  Schema.Struct({ kind: Schema.Literal("property"), propertyId: SpacePropertyId }),
]);
export type SpaceCardPreview = typeof SpaceCardPreview.Type;

export const SPACE_CHART_TYPES = ["bar", "horizontal_bar", "line", "donut"] as const;
export const SPACE_CHART_Y_FUNCTIONS = ["sum", "average", "median", "min", "max"] as const;
export const SPACE_FEED_WINDOW_ROWS = 25;
export const SPACE_FEED_PREVIEW_ROW_BYTES = 2048;
export const SPACE_CHART_MAX_BARS = 50;

const optional = Schema.optionalKey;
const cardSize = Schema.Literals(["small", "medium", "large"]);
const commonLayout = {
  openPagesIn: optional(Schema.Literals(["side_peek", "center_peek", "full_page"])),
  loadLimit: optional(Schema.Literals([10, 25, 50, 100])),
  subItems: optional(Schema.Literals(["nested", "flattened", "disabled"])),
};

/** Layout shape per view type; the server validates writes against these. */
export const SpaceKnownViewLayout = {
  table: Schema.Struct({
    ...commonLayout,
    wrapCells: optional(Schema.Boolean),
    showVerticalLines: optional(Schema.Boolean),
    frozenColumns: optional(NonNegativeInt),
    showRowNumbers: optional(Schema.Boolean),
  }),
  board: Schema.Struct({
    ...commonLayout,
    cardSize: optional(cardSize),
    cardPreview: optional(SpaceCardPreview),
    fitImage: optional(Schema.Boolean),
    colorColumns: optional(Schema.Boolean),
    wrapProperties: optional(Schema.Boolean),
  }),
  list: Schema.Struct({ ...commonLayout, showPropertyNames: optional(Schema.Boolean) }),
  gallery: Schema.Struct({
    ...commonLayout,
    cardSize: optional(cardSize),
    cardPreview: optional(SpaceCardPreview),
    fitImage: optional(Schema.Boolean),
  }),
  calendar: Schema.Struct({
    ...commonLayout,
    datePropertyId: SpacePropertyId,
    showWeekends: optional(Schema.Boolean),
    mode: optional(Schema.Literals(["month", "week"])),
    weekStart: optional(Schema.Literals(["sunday", "monday"])),
  }),
  timeline: Schema.Struct({
    ...commonLayout,
    startPropertyId: SpacePropertyId,
    endPropertyId: optional(SpacePropertyId),
    zoom: optional(Schema.Literals(["hours", "day", "week", "biweek", "month", "quarter", "year"])),
    showTable: optional(Schema.Boolean),
    tableWidth: optional(PositiveInt),
  }),
  chart: Schema.Struct({
    ...commonLayout,
    /** Absent is "bar". */
    chartType: optional(Schema.Literals(SPACE_CHART_TYPES)),
    /** Absent counts rows. */
    y: optional(
      Schema.Struct({
        property: SpacePropertyId,
        function: Schema.Literals(SPACE_CHART_Y_FUNCTIONS),
      }),
    ),
    /** Absent is true. */
    colorByOption: optional(Schema.Boolean),
    sortByValue: optional(Schema.Literals(["ascending", "descending"])),
    showValues: optional(Schema.Boolean),
  }),
  form: Schema.Struct({
    ...commonLayout,
    questions: optional(
      Schema.Array(SpaceFormQuestion).check(Schema.isMaxLength(SPACE_FORM_MAX_QUESTIONS)),
    ),
    description: optional(Schema.String.check(Schema.isMaxLength(SPACE_FORM_DESCRIPTION_MAX))),
  }),
  feed: Schema.Struct({
    ...commonLayout,
    /** Absent is 3. */
    previewBlocks: optional(Schema.Literals([0, 1, 3, 5, 10])),
  }),
} as const satisfies Record<SpaceViewType, Schema.Top>;

const knownView = <const Type extends keyof typeof SpaceKnownViewLayout>(type: Type) =>
  Schema.Struct({
    id: SpaceViewId,
    databaseId: SpaceDatabaseId,
    dataSourceId: SpaceDataSourceId,
    name: Schema.String,
    type: Schema.Literal(type),
    position: Schema.Int,
    filter: optional(SpaceKnownFilter),
    sorts: Schema.Array(SpaceKnownSort),
    group: optional(SpaceKnownGroup),
    subGroup: optional(SpaceKnownGroup),
    properties: Schema.Array(SpaceKnownViewProperty),
    layout: SpaceKnownViewLayout[type],
    ownerBlockId: optional(SpaceBlockId),
  });
export const SpaceKnownDatabaseView = Schema.Union([
  knownView("table"),
  knownView("board"),
  knownView("list"),
  knownView("gallery"),
  knownView("calendar"),
  knownView("timeline"),
  knownView("chart"),
  knownView("form"),
  knownView("feed"),
]);
export type SpaceKnownDatabaseView = typeof SpaceKnownDatabaseView.Type;
