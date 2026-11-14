import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import {
  SpaceAssetId,
  SpaceBlockId,
  SpaceId,
  SpaceKnownMark,
  SpaceRichRun,
  SpacePageIcon,
  SpacePageId,
  StableId,
  spaceBlockBase,
} from "./spacesCore.ts";

// This file and the other spacesDatabase*.ts files import only from spacesCore.ts and
// baseSchemas.ts. spaces.ts imports them, so importing spaces.ts here would be a cycle.

export const SpaceDatabaseId = StableId.pipe(Schema.brand("SpaceDatabaseId"));
export type SpaceDatabaseId = typeof SpaceDatabaseId.Type;
export const SpaceDataSourceId = StableId.pipe(Schema.brand("SpaceDataSourceId"));
export type SpaceDataSourceId = typeof SpaceDataSourceId.Type;
export const SpaceViewId = StableId.pipe(Schema.brand("SpaceViewId"));
export type SpaceViewId = typeof SpaceViewId.Type;
// The id format (`title` or ^[a-z0-9]{4,12}$) is enforced by the server so stored ids always decode.
export const SpacePropertyId = StableId.pipe(Schema.brand("SpacePropertyId"));
export type SpacePropertyId = typeof SpacePropertyId.Type;
export const SpaceOptionId = StableId.pipe(Schema.brand("SpaceOptionId"));
export type SpaceOptionId = typeof SpaceOptionId.Type;
export const SPACE_TITLE_PROPERTY_ID = "title";

export const SPACE_DATABASE_COLORS = [
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;
export const SpaceDatabaseColor = Schema.Literals(SPACE_DATABASE_COLORS);
export type SpaceDatabaseColor = typeof SpaceDatabaseColor.Type;
export const SpaceStatusGroup = Schema.Literals(["todo", "in_progress", "complete"]);
export type SpaceStatusGroup = typeof SpaceStatusGroup.Type;

export const SPACE_PROPERTY_TYPES = [
  "title",
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "files",
  "relation",
  "rollup",
  "formula",
  "created_time",
  "last_edited_time",
  "unique_id",
] as const;
export const SpacePropertyType = Schema.Literals(SPACE_PROPERTY_TYPES);
export type SpacePropertyType = typeof SpacePropertyType.Type;

export const SPACE_VIEW_TYPES = [
  "table",
  "board",
  "list",
  "gallery",
  "calendar",
  "timeline",
] as const;
export const SpaceViewType = Schema.Literals(SPACE_VIEW_TYPES);
export type SpaceViewType = typeof SpaceViewType.Type;

export const SPACE_NUMBER_FORMATS = [
  "number",
  "number_with_commas",
  "percent",
  "dollar",
  "euro",
  "pound",
  "yen",
  "ruble",
  "rupee",
  "won",
  "yuan",
  "real",
  "lira",
  "rupiah",
  "franc",
  "hong_kong_dollar",
  "new_zealand_dollar",
  "krona",
  "norwegian_krone",
  "mexican_peso",
  "rand",
  "new_taiwan_dollar",
  "danish_krone",
  "zloty",
  "baht",
  "forint",
  "koruna",
  "shekel",
  "chilean_peso",
  "philippine_peso",
  "dirham",
  "colombian_peso",
  "riyal",
  "ringgit",
  "leu",
  "argentine_peso",
  "uruguayan_peso",
  "singapore_dollar",
  "australian_dollar",
  "canadian_dollar",
] as const;
export const SpaceNumberFormat = Schema.Literals(SPACE_NUMBER_FORMATS);
export type SpaceNumberFormat = typeof SpaceNumberFormat.Type;

const SPACE_ROLLUP_FUNCTIONS = [
  "show_original",
  "show_unique",
  "count_all",
  "count_values",
  "count_unique",
  "count_empty",
  "count_not_empty",
  "percent_empty",
  "percent_not_empty",
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
  "earliest_date",
  "latest_date",
  "date_range",
  "checked",
  "unchecked",
  "percent_checked",
  "percent_unchecked",
] as const;
export const SpaceRollupFunction = Schema.Literals(SPACE_ROLLUP_FUNCTIONS);
export type SpaceRollupFunction = typeof SpaceRollupFunction.Type;

/** What the server knows about a formula or rollup: its result type and whether it can be queried. */
export const SpaceComputedInfo = Schema.StructWithRest(
  Schema.Struct({
    /** The formula type of the result, as JSON (`"number"`, `{"list":"text"}`, `{"page":"<data source>"}`). */
    resultType: Schema.Json,
    /** The stored property type the value filters, sorts and groups as; absent means display-only. */
    queryType: Schema.optionalKey(Schema.String),
    volatile: Schema.optionalKey(Schema.Boolean),
    /** Own-row property ids the value reads directly. */
    inputs: Schema.optionalKey(Schema.Array(SpacePropertyId)),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type SpaceComputedInfo = typeof SpaceComputedInfo.Type;

// Property: the envelope is what reads return and decodes unknown future types without loss.
export const SpaceDatabaseProperty = Schema.StructWithRest(
  Schema.Struct({
    id: SpacePropertyId,
    name: Schema.String,
    type: StableId,
    config: Schema.Json,
    position: Schema.Int,
    description: Schema.optionalKey(Schema.String),
    computed: Schema.optionalKey(SpaceComputedInfo),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type SpaceDatabaseProperty = typeof SpaceDatabaseProperty.Type;
export const SpaceDatabaseOption = Schema.Struct({
  id: SpaceOptionId,
  name: Schema.String,
  color: SpaceDatabaseColor,
});
export type SpaceDatabaseOption = typeof SpaceDatabaseOption.Type;
export const SpaceDatabaseStatusOption = Schema.Struct({
  ...SpaceDatabaseOption.fields,
  group: SpaceStatusGroup,
});
export type SpaceDatabaseStatusOption = typeof SpaceDatabaseStatusOption.Type;

const dateDisplayConfig = Schema.Struct({
  dateFormat: Schema.optionalKey(
    Schema.Literals(["full", "short", "mdy", "dmy", "ymd", "relative"]),
  ),
  timeFormat: Schema.optionalKey(Schema.Literals(["12h", "24h", "hidden"])),
});
// A bare Struct({}) accepts any object even with onExcessProperty "error".
const emptyConfig = Schema.Record(Schema.String, Schema.Never);

/** Config shape per property type; the server validates writes against these. */
export const SpaceKnownPropertyConfig = {
  title: emptyConfig,
  text: emptyConfig,
  checkbox: emptyConfig,
  url: emptyConfig,
  email: emptyConfig,
  phone: emptyConfig,
  files: emptyConfig,
  number: Schema.Struct({
    format: SpaceNumberFormat,
    decimals: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
    showAs: Schema.optionalKey(
      Schema.Struct({
        kind: Schema.Literals(["number", "bar", "ring"]),
        color: Schema.optionalKey(SpaceDatabaseColor),
        divideBy: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
        showNumber: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
  select: Schema.Struct({ options: Schema.Array(SpaceDatabaseOption) }),
  multi_select: Schema.Struct({ options: Schema.Array(SpaceDatabaseOption) }),
  status: Schema.Struct({
    options: Schema.Array(SpaceDatabaseStatusOption),
    defaultOptionId: Schema.optionalKey(SpaceOptionId),
  }),
  date: dateDisplayConfig,
  created_time: dateDisplayConfig,
  last_edited_time: dateDisplayConfig,
  relation: Schema.Struct({
    dataSourceId: SpaceDataSourceId,
    limit: Schema.Literals(["one", "many"]),
    twoWay: Schema.optionalKey(Schema.Struct({ propertyId: SpacePropertyId })),
  }),
  rollup: Schema.Struct({
    relationPropertyId: SpacePropertyId,
    targetPropertyId: SpacePropertyId,
    function: SpaceRollupFunction,
    format: Schema.optionalKey(SpaceNumberFormat),
    decimals: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
  }),
  // The byte cap (maxFormulaBytes) is server policy.
  formula: Schema.Struct({
    expression: Schema.String,
    format: Schema.optionalKey(SpaceNumberFormat),
    decimals: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
  }),
  unique_id: Schema.Struct({
    prefix: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{0,16}$/))),
  }),
} as const satisfies Record<SpacePropertyType, Schema.Top>;

const knownProperty = <const Type extends SpacePropertyType>(type: Type) =>
  Schema.Struct({
    id: SpacePropertyId,
    name: Schema.String,
    type: Schema.Literal(type),
    config: SpaceKnownPropertyConfig[type],
    position: Schema.Int,
    description: Schema.optionalKey(Schema.String),
  });
export const SpaceKnownDatabaseProperty = Schema.Union([
  knownProperty("title"),
  knownProperty("text"),
  knownProperty("number"),
  knownProperty("select"),
  knownProperty("multi_select"),
  knownProperty("status"),
  knownProperty("date"),
  knownProperty("checkbox"),
  knownProperty("url"),
  knownProperty("email"),
  knownProperty("phone"),
  knownProperty("files"),
  knownProperty("relation"),
  knownProperty("rollup"),
  knownProperty("formula"),
  knownProperty("created_time"),
  knownProperty("last_edited_time"),
  knownProperty("unique_id"),
]);
export type SpaceKnownDatabaseProperty = typeof SpaceKnownDatabaseProperty.Type;

export const SpaceCellValue = Schema.Json;
export type SpaceCellValue = typeof SpaceCellValue.Type;
export const SpaceCellMap = Schema.Record(Schema.String, SpaceCellValue);
export type SpaceCellMap = typeof SpaceCellMap.Type;

export const SpaceDateValue = Schema.Struct({
  start: Schema.String,
  end: Schema.optionalKey(Schema.String),
  timeZone: Schema.optionalKey(Schema.String),
});
export type SpaceDateValue = typeof SpaceDateValue.Type;
export const SpaceFileItem = Schema.Union([
  Schema.Struct({ name: Schema.String, url: Schema.String }),
  Schema.Struct({ name: Schema.String, assetId: SpaceAssetId }),
]);
export type SpaceFileItem = typeof SpaceFileItem.Type;
// Known types: string, number, boolean, date, page, array. Unknown types decode through the envelope.
export const SpaceComputedValue = Schema.StructWithRest(
  Schema.Struct({ type: StableId, value: Schema.Json }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type SpaceComputedValue = typeof SpaceComputedValue.Type;

/** Strict shapes of the known computed value types, for clients that render them. */
export const SpaceKnownComputedValue = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("string"),
    value: Schema.String,
    runs: Schema.optionalKey(Schema.Array(SpaceRichRun)),
    color: Schema.optionalKey(SpaceDatabaseColor),
  }),
  Schema.Struct({ type: Schema.Literal("number"), value: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("boolean"), value: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("date"), value: SpaceDateValue }),
  Schema.Struct({
    type: Schema.Literal("page"),
    value: SpacePageId,
    dataSourceId: Schema.optionalKey(SpaceDataSourceId),
  }),
  Schema.Struct({
    type: Schema.Literal("array"),
    value: Schema.Array(SpaceComputedValue),
    truncated: Schema.optionalKey(Schema.Boolean),
  }),
]);

type ScalarFormulaType = "number" | "text" | "boolean" | "date" | { readonly list: "text" };
/** The formula type of every property type that does not need the schema to know it. */
export const SPACE_FORMULA_TYPE_BY_PROPERTY = {
  title: "text",
  text: "text",
  url: "text",
  email: "text",
  phone: "text",
  select: "text",
  status: "text",
  unique_id: "text",
  multi_select: { list: "text" },
  files: { list: "text" },
  number: "number",
  checkbox: "boolean",
  date: "date",
  created_time: "date",
  last_edited_time: "date",
} as const satisfies Partial<Record<SpacePropertyType, ScalarFormulaType>>;

const isPropertyType = Schema.is(SpacePropertyType);
/** The type a property filters, sorts and groups as: its own, or `computed.queryType` for formula and rollup. */
export function spacePropertyQueryType(
  property: SpaceDatabaseProperty,
): SpacePropertyType | undefined {
  if (property.type !== "formula" && property.type !== "rollup")
    return isPropertyType(property.type) ? property.type : undefined;
  const queryType = property.computed?.queryType;
  return queryType !== undefined && isPropertyType(queryType) ? queryType : undefined;
}

/** Strict value shape per property type (read and write; read-only types are rejected on write). */
export const SpaceKnownCellValue = {
  title: Schema.String,
  text: Schema.Array(Schema.Struct({ text: Schema.String, marks: Schema.Array(SpaceKnownMark) })),
  number: Schema.Finite,
  select: SpaceOptionId,
  status: SpaceOptionId,
  multi_select: Schema.Array(SpaceOptionId),
  date: SpaceDateValue,
  checkbox: Schema.Boolean,
  url: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  files: Schema.Array(SpaceFileItem),
  relation: Schema.Array(SpacePageId),
  unique_id: Schema.Struct({
    number: PositiveInt,
    prefix: Schema.optionalKey(Schema.String),
  }),
  created_time: IsoDateTime,
  last_edited_time: IsoDateTime,
  formula: SpaceComputedValue,
  rollup: SpaceComputedValue,
} as const satisfies Record<SpacePropertyType, Schema.Top>;

export const SPACE_SORTABLE_TYPES = [
  "title",
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "files",
  "relation",
  "created_time",
  "last_edited_time",
  "unique_id",
] as const satisfies readonly SpacePropertyType[];
export const SPACE_GROUPABLE_TYPES = [
  "title",
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "relation",
  "created_time",
  "last_edited_time",
  "unique_id",
] as const satisfies readonly SpacePropertyType[];

export const SpaceDatabase = Schema.Struct({
  id: SpaceDatabaseId,
  spaceId: SpaceId,
  title: Schema.String,
  icon: Schema.optionalKey(SpacePageIcon),
  revision: NonNegativeInt,
  home: Schema.NullOr(Schema.Struct({ pageId: SpacePageId, blockId: SpaceBlockId })),
  live: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SpaceDatabase = typeof SpaceDatabase.Type;
export const SpaceDataSource = Schema.Struct({
  id: SpaceDataSourceId,
  databaseId: SpaceDatabaseId,
  name: Schema.String,
  position: Schema.Int,
  schemaRevision: NonNegativeInt,
  dataRevision: NonNegativeInt,
  properties: Schema.Record(Schema.String, SpaceDatabaseProperty),
  deletedProperties: Schema.Array(
    Schema.Struct({
      id: SpacePropertyId,
      name: Schema.String,
      type: StableId,
      deletedAt: IsoDateTime,
    }),
  ),
  subItems: Schema.optionalKey(
    Schema.Struct({ parentPropertyId: SpacePropertyId, childrenPropertyId: SpacePropertyId }),
  ),
  defaultTemplateId: Schema.optionalKey(SpacePageId),
  templates: Schema.Array(
    Schema.Struct({
      pageId: SpacePageId,
      title: Schema.String,
      icon: Schema.optionalKey(SpacePageIcon),
    }),
  ),
});
export type SpaceDataSource = typeof SpaceDataSource.Type;
export const SpaceDatabaseRow = Schema.Struct({
  page: Schema.Struct({
    id: SpacePageId,
    title: Schema.String,
    icon: Schema.optionalKey(SpacePageIcon),
    revision: NonNegativeInt,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }),
  number: PositiveInt,
  cells: SpaceCellMap,
  /** Present when the query scoped to a parent row (sub-items): its live children. */
  childCount: Schema.optionalKey(NonNegativeInt),
  /** Present when the query asked for `include.cover` and the page body starts with an image. */
  cover: Schema.optionalKey(
    Schema.Struct({
      url: Schema.optionalKey(Schema.String),
      assetId: Schema.optionalKey(SpaceAssetId),
    }),
  ),
});
export type SpaceDatabaseRow = typeof SpaceDatabaseRow.Type;
export const SpaceRelatedPage = Schema.Struct({
  title: Schema.String,
  icon: Schema.optionalKey(SpacePageIcon),
  dataSourceId: SpaceDataSourceId,
});
export type SpaceRelatedPage = typeof SpaceRelatedPage.Type;

/** Not part of SpaceKnownBlock: client editors switch over that union. Older clients see an unknown block. */
export const SpaceDatabaseBlock = Schema.Struct({
  ...spaceBlockBase,
  type: Schema.Literal("database"),
  content: Schema.Struct({ databaseId: SpaceDatabaseId, viewIds: Schema.Array(SpaceViewId) }),
});
export type SpaceDatabaseBlock = typeof SpaceDatabaseBlock.Type;

export const SpaceDatabaseLimits = Schema.Struct({
  maxDataSourcesPerDatabase: PositiveInt,
  maxViewsPerDatabase: PositiveInt,
  maxPropertiesPerDataSource: PositiveInt,
  maxDeletedPropertiesPerDataSource: PositiveInt,
  maxOptionsPerProperty: PositiveInt,
  maxNameBytes: PositiveInt,
  maxRowsPerDataSource: PositiveInt,
  maxRowsPerMutation: PositiveInt,
  maxCellsPerMutation: PositiveInt,
  maxSchemaOperations: PositiveInt,
  maxCellTextBytes: PositiveInt,
  maxCellItems: PositiveInt,
  maxSortKeyBytes: PositiveInt,
  maxFormulaBytes: PositiveInt,
  maxSchemaBytes: PositiveInt,
  maxViewBytes: PositiveInt,
  maxQueryRows: PositiveInt,
  maxQueryResponseBytes: PositiveInt,
  maxFilterDepth: PositiveInt,
  maxFilterConditions: PositiveInt,
  maxSorts: PositiveInt,
  maxGroupBuckets: PositiveInt,
  maxGroupPreviewRows: PositiveInt,
  maxAggregates: PositiveInt,
  maxRelatedPages: PositiveInt,
  maxCursorBytes: PositiveInt,
  maxSubItemDepth: PositiveInt,
});
export type SpaceDatabaseLimits = typeof SpaceDatabaseLimits.Type;
