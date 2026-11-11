import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, IsoDateTime } from "./baseSchemas.ts";
import {
  SpaceBlockId,
  SpaceId,
  SpacePageIcon,
  SpacePageId,
  mutationAck,
  mutationInput,
} from "./spacesCore.ts";
import {
  SpaceAggregateFunction,
  SpaceKnownFilter,
  SpaceKnownGroup,
  SpaceKnownSort,
} from "./spacesDatabaseFilters.ts";
import { SpaceKnownViewProperty } from "./spacesDatabaseViews.ts";
import {
  SpaceCellMap,
  SpaceDataSourceId,
  SpaceDatabaseColor,
  SpaceDatabaseId,
  SpaceOptionId,
  SpacePropertyId,
  SpacePropertyType,
  SpaceStatusGroup,
  SpaceViewId,
  SpaceViewType,
} from "./spacesDatabases.ts";

const optional = Schema.optionalKey;
const nullable = <S extends Schema.Top>(schema: S) => optional(Schema.NullOr(schema));

export class SpaceDatabaseError extends Schema.TaggedError<SpaceDatabaseError>()(
  "SpaceDatabaseError",
  {
    reason: Schema.Literals([
      // Declared in the contract but not implemented in this server version.
      "unsupported",
      // Filter, sort, group or aggregate on formula or rollup until workflow 3.
      "property_not_queryable",
      "operator_not_supported",
      "invalid_filter",
      "invalid_sort",
      "invalid_group",
      "invalid_aggregate",
      "invalid_scope",
      "invalid_value",
      "read_only_property",
      "unknown_option",
      "duplicate_name",
      // Attempt to remove, retype or duplicate the title property.
      "title_property",
      "invalid_property_config",
      "invalid_relation_target",
      "relation_limit",
      // Sub-item parent chain.
      "cycle",
      "data_source_not_empty",
      "last_data_source",
      "last_view",
      "last_option",
      "invalid_view",
      "invalid_time_zone",
      // The page is not a row of the named data source.
      "not_a_row",
    ]),
    propertyId: optional(SpacePropertyId),
  },
) {
  override get message(): string {
    return "The Spaces database request is invalid.";
  }
}

export const SpaceOptionDraft = Schema.Struct({
  id: optional(SpaceOptionId),
  name: Schema.String,
  color: optional(SpaceDatabaseColor),
  group: optional(SpaceStatusGroup),
});
export type SpaceOptionDraft = typeof SpaceOptionDraft.Type;
export const SpacePropertyDraft = Schema.Struct({
  id: optional(SpacePropertyId),
  name: Schema.String,
  type: SpacePropertyType,
  config: optional(Schema.Json),
  description: optional(Schema.String),
  options: optional(Schema.Array(SpaceOptionDraft)),
});
export type SpacePropertyDraft = typeof SpacePropertyDraft.Type;
export const SpaceRowDraft = Schema.Struct({
  title: optional(Schema.String),
  icon: optional(SpacePageIcon),
  cells: optional(SpaceCellMap),
  asTemplate: optional(Schema.Boolean),
  templateId: optional(SpacePageId),
});
export type SpaceRowDraft = typeof SpaceRowDraft.Type;
export const SpaceViewPropertyPatch = Schema.Struct({
  visible: optional(Schema.Boolean),
  width: nullable(PositiveInt),
  wrap: nullable(Schema.Boolean),
  aggregate: nullable(SpaceAggregateFunction),
});
export type SpaceViewPropertyPatch = typeof SpaceViewPropertyPatch.Type;

// A `before...Id` of null or absent means "at the end".
export const SpaceSchemaOperation = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("addProperty"),
    property: SpacePropertyDraft,
    beforePropertyId: nullable(SpacePropertyId),
  }),
  Schema.Struct({
    op: Schema.Literal("updateProperty"),
    propertyId: SpacePropertyId,
    name: optional(Schema.String),
    description: nullable(Schema.String),
    // Replaces the whole config except options, and must not contain an `options` key.
    config: optional(Schema.Json),
  }),
  Schema.Struct({
    op: Schema.Literal("changePropertyType"),
    propertyId: SpacePropertyId,
    type: SpacePropertyType,
    config: optional(Schema.Json),
  }),
  Schema.Struct({
    op: Schema.Literal("moveProperty"),
    propertyId: SpacePropertyId,
    beforePropertyId: Schema.NullOr(SpacePropertyId),
  }),
  Schema.Struct({ op: Schema.Literal("removeProperty"), propertyId: SpacePropertyId }),
  Schema.Struct({ op: Schema.Literal("restoreProperty"), propertyId: SpacePropertyId }),
  Schema.Struct({
    op: Schema.Literal("addOption"),
    propertyId: SpacePropertyId,
    option: SpaceOptionDraft,
    beforeOptionId: nullable(SpaceOptionId),
  }),
  Schema.Struct({
    op: Schema.Literal("updateOption"),
    propertyId: SpacePropertyId,
    optionId: SpaceOptionId,
    name: optional(Schema.String),
    color: optional(SpaceDatabaseColor),
    group: optional(SpaceStatusGroup),
  }),
  Schema.Struct({
    op: Schema.Literal("moveOption"),
    propertyId: SpacePropertyId,
    optionId: SpaceOptionId,
    beforeOptionId: Schema.NullOr(SpaceOptionId),
  }),
  Schema.Struct({
    op: Schema.Literal("removeOption"),
    propertyId: SpacePropertyId,
    optionId: SpaceOptionId,
  }),
]);
export type SpaceSchemaOperation = typeof SpaceSchemaOperation.Type;

// Database mutations are last-writer-wins, so there is no conflict result.
const saved = { status: Schema.Literal("saved"), ...mutationAck };
const revision = { revision: NonNegativeInt };
const blockRef = Schema.Struct({ pageId: SpacePageId, blockId: SpaceBlockId });
const blockResult = Schema.Struct({
  pageId: SpacePageId,
  blockId: SpaceBlockId,
  revision: NonNegativeInt,
});

export const SpaceDatabaseCreateInput = Schema.Struct({
  ...mutationInput,
  spaceId: SpaceId,
  title: Schema.String,
  icon: optional(SpacePageIcon),
  properties: optional(Schema.Array(SpacePropertyDraft)),
  appendToPageId: optional(SpacePageId),
});
export type SpaceDatabaseCreateInput = typeof SpaceDatabaseCreateInput.Type;
export const SpaceDatabaseCreateResult = Schema.Struct({
  ...saved,
  databaseId: SpaceDatabaseId,
  dataSourceId: SpaceDataSourceId,
  viewId: SpaceViewId,
  /** Same order as the input `properties`. */
  propertyIds: Schema.Array(SpacePropertyId),
  block: optional(blockResult),
});
export type SpaceDatabaseCreateResult = typeof SpaceDatabaseCreateResult.Type;

export const SpaceDatabaseUpdateInput = Schema.Struct({
  ...mutationInput,
  databaseId: SpaceDatabaseId,
  title: optional(Schema.String),
  /** Absent keeps the icon, null clears it. */
  icon: nullable(SpacePageIcon),
});
export type SpaceDatabaseUpdateInput = typeof SpaceDatabaseUpdateInput.Type;
export const SpaceDatabaseUpdateResult = Schema.Struct({
  ...saved,
  databaseId: SpaceDatabaseId,
  ...revision,
});
export type SpaceDatabaseUpdateResult = typeof SpaceDatabaseUpdateResult.Type;

export const SpaceDataSourceCreateInput = Schema.Struct({
  ...mutationInput,
  databaseId: SpaceDatabaseId,
  name: Schema.String,
  properties: optional(Schema.Array(SpacePropertyDraft)),
});
export type SpaceDataSourceCreateInput = typeof SpaceDataSourceCreateInput.Type;
export const SpaceDataSourceCreateResult = Schema.Struct({
  ...saved,
  dataSourceId: SpaceDataSourceId,
  propertyIds: Schema.Array(SpacePropertyId),
  /** Database revision. */
  ...revision,
});
export type SpaceDataSourceCreateResult = typeof SpaceDataSourceCreateResult.Type;

export const SpaceDataSourceUpdateInput = Schema.Struct({
  ...mutationInput,
  dataSourceId: SpaceDataSourceId,
  name: optional(Schema.String),
  subItems: nullable(Schema.Struct({ parentPropertyId: SpacePropertyId })),
  defaultTemplateId: nullable(SpacePageId),
});
export type SpaceDataSourceUpdateInput = typeof SpaceDataSourceUpdateInput.Type;
export const SpaceDataSourceUpdateResult = Schema.Struct({
  ...saved,
  dataSourceId: SpaceDataSourceId,
  schemaRevision: NonNegativeInt,
  /** Database revision. */
  ...revision,
});
export type SpaceDataSourceUpdateResult = typeof SpaceDataSourceUpdateResult.Type;

export const SpaceDataSourceDeleteInput = Schema.Struct({
  ...mutationInput,
  dataSourceId: SpaceDataSourceId,
});
export type SpaceDataSourceDeleteInput = typeof SpaceDataSourceDeleteInput.Type;
export const SpaceDataSourceDeleteResult = Schema.Struct({
  ...saved,
  dataSourceId: SpaceDataSourceId,
  /** Database revision. */
  ...revision,
});
export type SpaceDataSourceDeleteResult = typeof SpaceDataSourceDeleteResult.Type;

export const SpaceSchemaUpdateInput = Schema.Struct({
  ...mutationInput,
  dataSourceId: SpaceDataSourceId,
  operations: Schema.Array(SpaceSchemaOperation),
});
export type SpaceSchemaUpdateInput = typeof SpaceSchemaUpdateInput.Type;
export const SpaceSchemaUpdateResult = Schema.Struct({
  ...saved,
  dataSourceId: SpaceDataSourceId,
  schemaRevision: NonNegativeInt,
  dataRevision: NonNegativeInt,
  created: Schema.Array(
    Schema.Struct({
      index: Schema.Int,
      propertyId: optional(SpacePropertyId),
      optionId: optional(SpaceOptionId),
    }),
  ),
  clearedCells: NonNegativeInt,
  affectedDataSourceIds: Schema.Array(SpaceDataSourceId),
});
export type SpaceSchemaUpdateResult = typeof SpaceSchemaUpdateResult.Type;

export const SpaceViewCreateInput = Schema.Struct({
  ...mutationInput,
  dataSourceId: SpaceDataSourceId,
  name: Schema.String,
  type: SpaceViewType,
  filter: optional(SpaceKnownFilter),
  sorts: optional(Schema.Array(SpaceKnownSort)),
  group: optional(SpaceKnownGroup),
  subGroup: optional(SpaceKnownGroup),
  properties: optional(Schema.Array(SpaceKnownViewProperty)),
  layout: optional(Schema.Json),
  beforeViewId: nullable(SpaceViewId),
  block: optional(blockRef),
});
export type SpaceViewCreateInput = typeof SpaceViewCreateInput.Type;
export const SpaceViewCreateResult = Schema.Struct({
  ...saved,
  viewId: SpaceViewId,
  /** Database revision. */
  ...revision,
  block: optional(blockResult),
});
export type SpaceViewCreateResult = typeof SpaceViewCreateResult.Type;

export const SpaceViewUpdateInput = Schema.Struct({
  ...mutationInput,
  viewId: SpaceViewId,
  name: optional(Schema.String),
  type: optional(SpaceViewType),
  /** Each present field replaces that field; null removes it. */
  filter: nullable(SpaceKnownFilter),
  sorts: optional(Schema.Array(SpaceKnownSort)),
  group: nullable(SpaceKnownGroup),
  subGroup: nullable(SpaceKnownGroup),
  properties: optional(
    Schema.Struct({
      set: optional(Schema.Record(Schema.String, Schema.NullOr(SpaceViewPropertyPatch))),
      order: optional(Schema.Array(SpacePropertyId)),
    }),
  ),
  layout: optional(Schema.Json),
  beforeViewId: nullable(SpaceViewId),
});
export type SpaceViewUpdateInput = typeof SpaceViewUpdateInput.Type;
export const SpaceViewUpdateResult = Schema.Struct({
  ...saved,
  viewId: SpaceViewId,
  /** Database revision. */
  ...revision,
});
export type SpaceViewUpdateResult = typeof SpaceViewUpdateResult.Type;

export const SpaceViewDeleteInput = Schema.Struct({
  ...mutationInput,
  viewId: SpaceViewId,
  block: optional(blockRef),
});
export type SpaceViewDeleteInput = typeof SpaceViewDeleteInput.Type;
export const SpaceViewDeleteResult = Schema.Struct({
  ...saved,
  viewId: SpaceViewId,
  /** Database revision. */
  ...revision,
  block: optional(blockResult),
});
export type SpaceViewDeleteResult = typeof SpaceViewDeleteResult.Type;

export const SpaceRowsCreateInput = Schema.Struct({
  ...mutationInput,
  dataSourceId: SpaceDataSourceId,
  rows: Schema.Array(SpaceRowDraft),
  beforeRowId: nullable(SpacePageId),
});
export type SpaceRowsCreateInput = typeof SpaceRowsCreateInput.Type;
export const SpaceRowsCreateResult = Schema.Struct({
  ...saved,
  dataSourceId: SpaceDataSourceId,
  dataRevision: NonNegativeInt,
  rows: Schema.Array(Schema.Struct({ pageId: SpacePageId, number: PositiveInt })),
});
export type SpaceRowsCreateResult = typeof SpaceRowsCreateResult.Type;

export const SpaceRowsUpdateInput = Schema.Struct({
  ...mutationInput,
  dataSourceId: SpaceDataSourceId,
  /** A null cell value clears it; absent keys are untouched. */
  rows: Schema.Array(
    Schema.Struct({
      pageId: SpacePageId,
      cells: Schema.Record(Schema.String, Schema.NullOr(Schema.Json)),
    }),
  ),
});
export type SpaceRowsUpdateInput = typeof SpaceRowsUpdateInput.Type;
export const SpaceRowsUpdateResult = Schema.Struct({
  ...saved,
  dataSourceId: SpaceDataSourceId,
  dataRevision: NonNegativeInt,
  rows: Schema.Array(
    Schema.Struct({ pageId: SpacePageId, revision: NonNegativeInt, updatedAt: IsoDateTime }),
  ),
  affectedDataSourceIds: Schema.Array(SpaceDataSourceId),
});
export type SpaceRowsUpdateResult = typeof SpaceRowsUpdateResult.Type;

export const SpaceRowsMoveInput = Schema.Struct({
  ...mutationInput,
  dataSourceId: SpaceDataSourceId,
  pageIds: Schema.Array(SpacePageId),
  beforeRowId: Schema.NullOr(SpacePageId),
});
export type SpaceRowsMoveInput = typeof SpaceRowsMoveInput.Type;
export const SpaceRowsMoveResult = Schema.Struct({
  ...saved,
  dataSourceId: SpaceDataSourceId,
  dataRevision: NonNegativeInt,
});
export type SpaceRowsMoveResult = typeof SpaceRowsMoveResult.Type;
