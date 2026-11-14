import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ensureDatabaseLimit } from "../CorePolicy.ts";
import { parseDateValue } from "./CellDate.ts";
import { isObject, strictOption } from "./Json.ts";
import type { Property, Snapshot } from "./SchemaStore.ts";
import { liveProperty } from "./SchemaStore.ts";
import { dbError } from "./Types.ts";

const computed = new Set<C.SpacePropertyType>(["formula", "rollup"]);
const dateTypes = new Set<C.SpacePropertyType>(["date", "created_time", "last_edited_time"]);
const textTypes = new Set<C.SpacePropertyType>(["title", "text", "url", "email", "phone"]);
const isGroupStatus = Schema.is(C.SpaceStatusGroup);
const within = Schema.decodeUnknownOption(C.SpaceWithinOperand, { onExcessProperty: "error" });
const relative = Schema.decodeUnknownOption(
  Schema.Struct({ relative: Schema.Literals(C.SPACE_RELATIVE_DATES) }),
  { onExcessProperty: "error" },
);

export const children = (node: C.SpaceKnownFilter) =>
  "and" in node ? node.and : "or" in node ? node.or : undefined;

export const isCondition = (
  node: C.SpaceKnownFilter,
): node is Extract<C.SpaceKnownFilter, { readonly property: C.SpacePropertyId }> =>
  children(node) === undefined;

/** Operands for date filters: a day, an instant with a zone, or a named relative day. */
const dateOperandValid = (value: unknown) =>
  (typeof value === "string" && parseDateValue({ start: value }) !== undefined) ||
  Option.isSome(relative(value));

const valueShape = (
  property: Property,
  operator: string,
  value: unknown,
  absentOk: boolean,
): boolean => {
  if (operator === "is_empty" || operator === "is_not_empty")
    return value === undefined || (absentOk && value === true);
  switch (property.type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
    case "relation":
      return typeof value === "string";
    case "number":
    case "unique_id":
      return typeof value === "number" && Number.isFinite(value);
    case "checkbox":
      return typeof value === "boolean";
    case "select":
    case "multi_select":
      return typeof value === "string";
    case "status":
      return operator === "in_group" || operator === "not_in_group"
        ? isGroupStatus(value)
        : typeof value === "string";
    case "date":
    case "created_time":
    case "last_edited_time": {
      if (operator !== "within") return dateOperandValid(value);
      const parsed = Option.getOrUndefined(within(value));
      return parsed !== undefined && (parsed.direction !== "this" || (parsed.count ?? 1) === 1);
    }
    default:
      return true;
  }
};

const validateCondition = Effect.fn("SpacesDatabases.validateCondition")(function* (
  snapshot: Snapshot,
  condition: Extract<C.SpaceKnownFilter, { readonly property: C.SpacePropertyId }>,
) {
  const property = yield* liveProperty(snapshot, condition.property);
  if (computed.has(property.type)) return yield* dbError("property_not_queryable", property.id);
  const legal: readonly string[] = C.SPACE_FILTER_OPERATORS[property.type];
  if (!legal.includes(condition.operator))
    return yield* dbError("operator_not_supported", property.id);
  if (condition.part !== undefined && property.type !== "date")
    return yield* dbError("invalid_filter", property.id);
  if (!valueShape(property, condition.operator, condition.value, true))
    return yield* dbError("invalid_filter", property.id);
  const optionValue =
    typeof condition.value === "string" &&
    (property.type === "select" ||
      property.type === "multi_select" ||
      (property.type === "status" &&
        condition.operator !== "in_group" &&
        condition.operator !== "not_in_group"));
  if (optionValue && !property.options.some((option) => option.option_id === condition.value))
    return yield* dbError("unknown_option", property.id);
});

export const validateFilter = Effect.fn("SpacesDatabases.validateFilter")(function* (
  snapshot: Snapshot,
  filter: C.SpaceKnownFilter,
) {
  const shape = C.measureSpaceFilter(filter as C.SpaceFilter);
  yield* ensureDatabaseLimit("maxFilterDepth", shape.depth);
  yield* ensureDatabaseLimit("maxFilterConditions", shape.conditions);
  const pending = [filter];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const nested = children(node);
    if (nested) pending.push(...nested);
    else if (isCondition(node)) yield* validateCondition(snapshot, node);
  }
});

const sortable = new Set<C.SpacePropertyType>(C.SPACE_SORTABLE_TYPES);
const groupable = new Set<C.SpacePropertyType>(C.SPACE_GROUPABLE_TYPES);

export const validateSorts = Effect.fn("SpacesDatabases.validateSorts")(function* (
  snapshot: Snapshot,
  sorts: readonly C.SpaceKnownSort[],
) {
  yield* ensureDatabaseLimit("maxSorts", sorts.length);
  const seen = new Set<string>();
  for (const sort of sorts) {
    const property = yield* liveProperty(snapshot, sort.property);
    if (computed.has(property.type)) return yield* dbError("property_not_queryable", property.id);
    if (!sortable.has(property.type) || seen.has(property.id))
      return yield* dbError("invalid_sort", property.id);
    seen.add(property.id);
  }
});

const rangeBy = strictOption(
  Schema.Struct({ range: Schema.Struct({ start: Schema.Finite, size: Schema.Finite }) }),
);

const byFits = (type: C.SpacePropertyType, by: C.SpaceKnownGroupBy | undefined) => {
  if (by === undefined) return true;
  if (typeof by === "object") return type === "number" || type === "unique_id";
  if (textTypes.has(type)) return by === "exact" || by === "alphabetical";
  if (dateTypes.has(type))
    return by === "day" || by === "week" || by === "month" || by === "year" || by === "relative";
  switch (type) {
    case "select":
    case "multi_select":
      return by === "option";
    case "status":
      return by === "option" || by === "status_group";
    case "checkbox":
      return by === "checkbox";
    case "relation":
      return by === "page";
    default:
      return false;
  }
};

export const validateGroup = Effect.fn("SpacesDatabases.validateGroup")(function* (
  snapshot: Snapshot,
  group: C.SpaceKnownGroup,
) {
  const property = yield* liveProperty(snapshot, group.property);
  if (computed.has(property.type)) return yield* dbError("property_not_queryable", property.id);
  if (!groupable.has(property.type) || !byFits(property.type, group.by))
    return yield* dbError("invalid_group", property.id);
  if (typeof group.by === "object" && !(rangeBy(group.by) && group.by.range.size > 0))
    return yield* dbError("invalid_group", property.id);
  if (group.by === "relative") return yield* dbError("unsupported", property.id);
  return property;
});

export const validateAggregate = Effect.fn("SpacesDatabases.validateAggregate")(function* (
  property: Property,
  fn: C.SpaceAggregateFunction,
) {
  if (computed.has(property.type)) return yield* dbError("property_not_queryable", property.id);
  const legal: readonly string[] = C.SPACE_AGGREGATES_BY_TYPE[property.type];
  if (!legal.includes(fn)) return yield* dbError("invalid_aggregate", property.id);
});

export const layoutDecoders = {
  table: strictOption(C.SpaceKnownViewLayout.table),
  board: strictOption(C.SpaceKnownViewLayout.board),
  list: strictOption(C.SpaceKnownViewLayout.list),
  gallery: strictOption(C.SpaceKnownViewLayout.gallery),
  calendar: strictOption(C.SpaceKnownViewLayout.calendar),
  timeline: strictOption(C.SpaceKnownViewLayout.timeline),
  chart: strictOption(C.SpaceKnownViewLayout.chart),
  form: strictOption(C.SpaceKnownViewLayout.form),
  feed: strictOption(C.SpaceKnownViewLayout.feed),
} as const;

/** Decodes `layout` strictly for the view type and checks every property it names. */
export const validateLayout = Effect.fn("SpacesDatabases.validateLayout")(function* (
  snapshot: Snapshot,
  type: C.SpaceViewType,
  layout: unknown,
  references = true,
) {
  const decoded = layoutDecoders[type](layout ?? {});
  if (decoded === undefined || !isObject(decoded)) {
    // A calendar or timeline that lost its date property is a defined state; an untouched layout may stay so.
    if (!references && isObject(layout)) return layout;
    return yield* dbError("invalid_view");
  }
  if (!references) return decoded;
  const named = Effect.fn("SpacesDatabases.layoutProperty")(function* (
    id: string | undefined,
    onlyDates: boolean,
  ) {
    if (id === undefined) return;
    const property = yield* liveProperty(snapshot, id);
    if (onlyDates && !dateTypes.has(property.type)) return yield* dbError("invalid_view", id);
  });
  if (type === "calendar" && "datePropertyId" in decoded)
    yield* named(String(decoded.datePropertyId), true);
  if (type === "timeline") {
    if ("startPropertyId" in decoded) yield* named(String(decoded.startPropertyId), true);
    if ("endPropertyId" in decoded) yield* named(String(decoded.endPropertyId), true);
  }
  if (type === "chart" && "y" in decoded && isObject(decoded.y)) {
    const id = String(decoded.y.property);
    const property = yield* liveProperty(snapshot, id);
    if (property.type !== "number") return yield* dbError("invalid_view", id);
  }
  if (type === "form" && "questions" in decoded && Array.isArray(decoded.questions)) {
    const seen = new Set<string>();
    for (const question of decoded.questions) {
      if (!isObject(question)) continue;
      const id = String(question.propertyId);
      const property = yield* liveProperty(snapshot, id);
      if (!C.isFormAnswerType(property.type) || seen.has(id))
        return yield* dbError("invalid_view", id);
      seen.add(id);
    }
  }
  const preview = "cardPreview" in decoded ? decoded.cardPreview : undefined;
  if (isObject(preview) && preview.kind === "property")
    yield* named(String(preview.propertyId), false);
  return decoded;
});
