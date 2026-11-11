import * as Schema from "effect/Schema";

import { PositiveInt } from "./baseSchemas.ts";
import { SpacePageId, StableId } from "./spacesCore.ts";
import {
  SpaceOptionId,
  SpacePropertyId,
  SpaceStatusGroup,
  type SpacePropertyType,
} from "./spacesDatabases.ts";

const Rest = [Schema.Record(Schema.String, Schema.Json)] as const;

export const SpaceFilterCondition = Schema.StructWithRest(
  Schema.Struct({
    property: SpacePropertyId,
    operator: StableId,
    value: Schema.optionalKey(Schema.Json),
    /** Date properties only; defaults to "start". */
    part: Schema.optionalKey(Schema.Literals(["start", "end"])),
  }),
  Rest,
);
type SpaceFilterConditionFields = {
  readonly property: SpacePropertyId;
  readonly operator: string;
  readonly value?: Schema.Json;
  readonly part?: "start" | "end";
};
export type SpaceFilterCondition = typeof SpaceFilterCondition.Type;
// Declared by hand because the schema is recursive; the condition's rest keys are not named here.
export type SpaceFilter =
  | { readonly and: ReadonlyArray<SpaceFilter> }
  | { readonly or: ReadonlyArray<SpaceFilter> }
  | SpaceFilterConditionFields;
type SpaceFilterEncoded =
  | { readonly and: ReadonlyArray<SpaceFilterEncoded> }
  | { readonly or: ReadonlyArray<SpaceFilterEncoded> }
  | typeof SpaceFilterCondition.Encoded;
// Depth and leaf limits are server policy; the schema accepts any nesting the codec stack allows.
export const SpaceFilter: Schema.Codec<SpaceFilter, SpaceFilterEncoded> = Schema.Union([
  Schema.Struct({
    and: Schema.Array(
      Schema.suspend((): Schema.Codec<SpaceFilter, SpaceFilterEncoded> => SpaceFilter),
    ),
  }),
  Schema.Struct({
    or: Schema.Array(
      Schema.suspend((): Schema.Codec<SpaceFilter, SpaceFilterEncoded> => SpaceFilter),
    ),
  }),
  SpaceFilterCondition,
]);

export interface SpaceFilterShape {
  /** Groups on the path from the root, counting the root group; a bare condition is 0. */
  readonly depth: number;
  readonly conditions: number;
}
export function measureSpaceFilter(filter: SpaceFilter): SpaceFilterShape {
  if ("and" in filter || "or" in filter) {
    const children = "and" in filter ? filter.and : filter.or;
    let depth = 0;
    let conditions = 0;
    for (const child of children) {
      const shape = measureSpaceFilter(child);
      depth = Math.max(depth, shape.depth);
      conditions += shape.conditions;
    }
    return { depth: depth + 1, conditions };
  }
  return { depth: 0, conditions: 1 };
}

const SPACE_FILTER_OPERATOR_NAMES = [
  "equals",
  "does_not_equal",
  "contains",
  "does_not_contain",
  "starts_with",
  "ends_with",
  "is_empty",
  "is_not_empty",
  "greater_than",
  "less_than",
  "greater_than_or_equal_to",
  "less_than_or_equal_to",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "within",
  "in_group",
  "not_in_group",
] as const;
export const SpaceFilterOperator = Schema.Literals(SPACE_FILTER_OPERATOR_NAMES);
export type SpaceFilterOperator = typeof SpaceFilterOperator.Type;
// Fails to compile when SPACE_FILTER_OPERATORS names an operator missing from the list above.
type MissingFilterOperator = Exclude<
  (typeof SPACE_FILTER_OPERATORS)[keyof typeof SPACE_FILTER_OPERATORS][number],
  SpaceFilterOperator
>;
const _assertNoMissingFilterOperator: [MissingFilterOperator] extends [never] ? true : never = true;

/** Mutation-input condition: exactly these keys, so a stored filter means the same to every reader. */
export const SpaceKnownFilterCondition = Schema.Struct({
  property: SpacePropertyId,
  operator: SpaceFilterOperator,
  value: Schema.optionalKey(Schema.Json),
  part: Schema.optionalKey(Schema.Literals(["start", "end"])),
});
export type SpaceKnownFilter =
  | { readonly and: ReadonlyArray<SpaceKnownFilter> }
  | { readonly or: ReadonlyArray<SpaceKnownFilter> }
  | typeof SpaceKnownFilterCondition.Type;
type SpaceKnownFilterEncoded =
  | { readonly and: ReadonlyArray<SpaceKnownFilterEncoded> }
  | { readonly or: ReadonlyArray<SpaceKnownFilterEncoded> }
  | typeof SpaceKnownFilterCondition.Encoded;
export const SpaceKnownFilter: Schema.Codec<SpaceKnownFilter, SpaceKnownFilterEncoded> =
  Schema.Union([
    Schema.Struct({
      and: Schema.Array(
        Schema.suspend(
          (): Schema.Codec<SpaceKnownFilter, SpaceKnownFilterEncoded> => SpaceKnownFilter,
        ),
      ),
    }),
    Schema.Struct({
      or: Schema.Array(
        Schema.suspend(
          (): Schema.Codec<SpaceKnownFilter, SpaceKnownFilterEncoded> => SpaceKnownFilter,
        ),
      ),
    }),
    SpaceKnownFilterCondition,
  ]);

export const SpaceSort = Schema.StructWithRest(
  Schema.Struct({
    property: SpacePropertyId,
    direction: Schema.Literals(["ascending", "descending"]),
  }),
  Rest,
);
export type SpaceSort = typeof SpaceSort.Type;
export const SpaceKnownSort = Schema.Struct({
  property: SpacePropertyId,
  direction: Schema.Literals(["ascending", "descending"]),
});
export type SpaceKnownSort = typeof SpaceKnownSort.Type;

export const SpaceGroupKey = Schema.StructWithRest(Schema.Struct({ kind: StableId }), Rest);
export type SpaceGroupKey = typeof SpaceGroupKey.Type;
export const SpaceKnownGroupKey = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("empty") }),
  Schema.Struct({ kind: Schema.Literal("option"), optionId: SpaceOptionId }),
  Schema.Struct({ kind: Schema.Literal("status_group"), group: SpaceStatusGroup }),
  Schema.Struct({ kind: Schema.Literal("checkbox"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("text"), value: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("number_range"),
    start: Schema.Finite,
    end: Schema.Finite,
  }),
  Schema.Struct({
    kind: Schema.Literal("date"),
    start: Schema.String,
    unit: Schema.Literals(["day", "week", "month", "year"]),
  }),
  Schema.Struct({ kind: Schema.Literal("page"), pageId: SpacePageId }),
]).annotate({ identifier: "SpaceKnownGroupKey" });
export type SpaceKnownGroupKey = typeof SpaceKnownGroupKey.Type;

export const SpaceKnownGroupBy = Schema.Union([
  Schema.Literals(["option", "status_group", "checkbox", "exact", "alphabetical", "page"]),
  Schema.Struct({
    range: Schema.Struct({
      start: Schema.Finite,
      size: Schema.Finite.check(Schema.isGreaterThan(0)),
    }),
  }),
  Schema.Literals(["day", "week", "month", "year", "relative"]),
]);
export type SpaceKnownGroupBy = typeof SpaceKnownGroupBy.Type;

export const SpaceGroup = Schema.StructWithRest(
  Schema.Struct({
    property: SpacePropertyId,
    by: Schema.optionalKey(Schema.Json),
    sort: Schema.optionalKey(Schema.Literals(["ascending", "descending", "manual"])),
    // The four fields below are presentation; the server ignores them.
    hideEmpty: Schema.optionalKey(Schema.Boolean),
    order: Schema.optionalKey(Schema.Array(SpaceGroupKey)),
    hidden: Schema.optionalKey(Schema.Array(SpaceGroupKey)),
    collapsed: Schema.optionalKey(Schema.Array(SpaceGroupKey)),
  }),
  Rest,
);
export type SpaceGroup = typeof SpaceGroup.Type;
export const SpaceKnownGroup = Schema.Struct({
  property: SpacePropertyId,
  by: Schema.optionalKey(SpaceKnownGroupBy),
  sort: Schema.optionalKey(Schema.Literals(["ascending", "descending", "manual"])),
  hideEmpty: Schema.optionalKey(Schema.Boolean),
  order: Schema.optionalKey(Schema.Array(SpaceKnownGroupKey)),
  hidden: Schema.optionalKey(Schema.Array(SpaceKnownGroupKey)),
  collapsed: Schema.optionalKey(Schema.Array(SpaceKnownGroupKey)),
}).annotate({ identifier: "SpaceKnownGroup" });
export type SpaceKnownGroup = typeof SpaceKnownGroup.Type;

const SPACE_AGGREGATE_FUNCTIONS = [
  "count",
  "count_values",
  "count_unique",
  "empty",
  "not_empty",
  "percent_empty",
  "percent_not_empty",
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
  "earliest",
  "latest",
  "date_range",
  "checked",
  "unchecked",
  "percent_checked",
  "percent_unchecked",
] as const;
export const SpaceAggregateFunction = Schema.Literals(SPACE_AGGREGATE_FUNCTIONS);
export type SpaceAggregateFunction = typeof SpaceAggregateFunction.Type;
export const SpaceAggregate = Schema.StructWithRest(
  Schema.Struct({ property: SpacePropertyId, function: StableId }),
  Rest,
);
export type SpaceAggregate = typeof SpaceAggregate.Type;
export const SpaceKnownAggregate = Schema.Struct({
  property: SpacePropertyId,
  function: SpaceAggregateFunction,
});
export type SpaceKnownAggregate = typeof SpaceKnownAggregate.Type;
// Neither `number` nor `date` present means "no value", for example the average of nothing.
export const SpaceAggregateResult = Schema.StructWithRest(
  Schema.Struct({
    property: SpacePropertyId,
    function: StableId,
    /** Counts, sums, percentages as a fraction 0..1, date_range in milliseconds. */
    number: Schema.optionalKey(Schema.Number),
    date: Schema.optionalKey(Schema.Struct({ start: Schema.String, hasTime: Schema.Boolean })),
  }),
  Rest,
);
export type SpaceAggregateResult = typeof SpaceAggregateResult.Type;

export const SPACE_RELATIVE_DATES = [
  "today",
  "tomorrow",
  "yesterday",
  "one_week_ago",
  "one_week_from_now",
  "one_month_ago",
  "one_month_from_now",
] as const;
export const SpaceDateOperand = Schema.Union([
  Schema.String,
  Schema.Struct({ relative: Schema.Literals(SPACE_RELATIVE_DATES) }),
]);
export type SpaceDateOperand = typeof SpaceDateOperand.Type;
export const SpaceWithinOperand = Schema.Struct({
  direction: Schema.Literals(["past", "next", "this"]),
  unit: Schema.Literals(["day", "week", "month", "year"]),
  count: Schema.optionalKey(PositiveInt),
});
export type SpaceWithinOperand = typeof SpaceWithinOperand.Type;

const textOperators = [
  "equals",
  "does_not_equal",
  "contains",
  "does_not_contain",
  "starts_with",
  "ends_with",
  "is_empty",
  "is_not_empty",
] as const;
const numberComparisons = [
  "equals",
  "does_not_equal",
  "greater_than",
  "less_than",
  "greater_than_or_equal_to",
  "less_than_or_equal_to",
] as const;
const dateOperators = [
  "equals",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "within",
] as const;
const emptiness = ["is_empty", "is_not_empty"] as const;

/** Legal filter operators per property type. formula and rollup are not queryable until workflow 3. */
export const SPACE_FILTER_OPERATORS = {
  title: textOperators,
  text: textOperators,
  url: textOperators,
  email: textOperators,
  phone: textOperators,
  number: [...numberComparisons, ...emptiness],
  unique_id: numberComparisons,
  checkbox: ["equals", "does_not_equal"],
  select: ["equals", "does_not_equal", ...emptiness],
  status: ["equals", "does_not_equal", "in_group", "not_in_group", ...emptiness],
  multi_select: ["contains", "does_not_contain", ...emptiness],
  date: [...dateOperators, ...emptiness],
  created_time: dateOperators,
  last_edited_time: dateOperators,
  files: emptiness,
  relation: ["contains", "does_not_contain", ...emptiness],
  formula: [],
  rollup: [],
} as const satisfies Record<SpacePropertyType, readonly string[]>;

const valueAggregates = [
  "count_values",
  "count_unique",
  "empty",
  "not_empty",
  "percent_empty",
  "percent_not_empty",
] as const;
const numericAggregates = ["sum", "average", "median", "min", "max", "range"] as const;
const dateAggregates = ["earliest", "latest", "date_range"] as const;

/** Legal aggregate functions per property type. formula and rollup are not queryable until workflow 3. */
export const SPACE_AGGREGATES_BY_TYPE = {
  title: ["count", ...valueAggregates],
  text: ["count", ...valueAggregates],
  url: ["count", ...valueAggregates],
  email: ["count", ...valueAggregates],
  phone: ["count", ...valueAggregates],
  select: ["count", ...valueAggregates],
  multi_select: ["count", ...valueAggregates],
  status: ["count", ...valueAggregates],
  files: ["count", ...valueAggregates],
  relation: ["count", ...valueAggregates],
  number: ["count", ...valueAggregates, ...numericAggregates],
  date: ["count", ...valueAggregates, ...dateAggregates],
  created_time: ["count", ...dateAggregates],
  last_edited_time: ["count", ...dateAggregates],
  checkbox: ["count", "checked", "unchecked", "percent_checked", "percent_unchecked"],
  unique_id: ["count"],
  formula: [],
  rollup: [],
} as const satisfies Record<SpacePropertyType, readonly SpaceAggregateFunction[]>;
