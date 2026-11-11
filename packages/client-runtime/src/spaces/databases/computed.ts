import { Option, Schema } from "effect";
import { computedInfoOf } from "./schema.ts";
import {
  SPACE_FORMULA_TYPE_BY_PROPERTY,
  SpaceKnownComputedValue,
  spacePropertyQueryType,
  type SpaceDataSource,
  type SpaceDatabaseProperty,
  type SpacePropertyId,
  type SpacePropertyType,
} from "@t2code/contracts/spaces";
import type { SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";
import type { FormulaProperty, FormulaSchema, FormulaType } from "@t2code/shared/formula";

const decodeComputedValue = Schema.decodeUnknownOption(SpaceKnownComputedValue);

/** The type a property filters, sorts and groups as; undefined for display-only computed ones. */
export const propertyQueryType = (property: SpaceDatabaseProperty): SpacePropertyType | undefined =>
  spacePropertyQueryType(property);

/** Why a formula or rollup cannot be filtered, sorted or grouped; undefined when it can (or is not computed). */
export function unqueryableReason(property: SpaceDatabaseProperty): string | undefined {
  if (!isComputedProperty(property)) return undefined;
  const computed = property.computed;
  if (computed === undefined) return "Not calculated yet";
  if (computed.error !== undefined) return computed.error.message;
  if (propertyQueryType(property) !== undefined) return undefined;
  return computed.volatile === true
    ? "Uses now() or today(), so it can't be filtered or sorted"
    : "This result type can't be filtered or sorted";
}

const isComputedProperty = (property: SpaceDatabaseProperty): boolean =>
  property.type === "formula" || property.type === "rollup";

function parseFormulaType(json: unknown): FormulaType {
  if (typeof json === "string")
    return json === "number" ||
      json === "text" ||
      json === "boolean" ||
      json === "date" ||
      json === "empty"
      ? json
      : "any";
  if (typeof json !== "object" || json === null) return "any";
  if ("list" in json) return { list: parseFormulaType(json.list) };
  if ("page" in json && typeof json.page === "string")
    return "far" in json && json.far === true
      ? { page: json.page, far: true }
      : { page: json.page };
  return "any";
}

const relationTarget = (property: SpaceDatabaseProperty): string | undefined => {
  const config: unknown = property.config;
  if (typeof config !== "object" || config === null || !("dataSourceId" in config))
    return undefined;
  return typeof config.dataSourceId === "string" ? config.dataSourceId : undefined;
};

/** The formula type of a property's value (plan table 1.4); `any` when it is not known yet. */
export function formulaTypeOfProperty(property: SpaceDatabaseProperty): FormulaType {
  if (property.type === "relation") {
    const target = relationTarget(property);
    return target === undefined ? "any" : { list: { page: target } };
  }
  if (property.type === "formula" || property.type === "rollup") {
    const computed = property.computed;
    return computed === undefined || computed.error !== undefined
      ? "any"
      : parseFormulaType(computed.resultType);
  }
  return Object.hasOwn(SPACE_FORMULA_TYPE_BY_PROPERTY, property.type)
    ? parseFormulaType(
        SPACE_FORMULA_TYPE_BY_PROPERTY[
          property.type as keyof typeof SPACE_FORMULA_TYPE_BY_PROPERTY
        ],
      )
    : "any";
}

function formulaProperty(property: SpaceDatabaseProperty): FormulaProperty {
  const target = property.type === "relation" ? relationTarget(property) : undefined;
  return {
    id: property.id,
    name: property.name,
    type: formulaTypeOfProperty(property),
    ...(target === undefined ? {} : { relationTo: target }),
    ...(property.computed?.volatile === true ? { volatile: true } : {}),
    ...(property.computed?.error === undefined ? {} : { broken: true }),
  };
}

/**
 * The checking schema of one data source. `lookup` finds the loaded data source of a relation
 * target; `source(id)` is undefined until it is loaded, and `databaseName` supplies message text.
 */
export function formulaSchemaOf(
  dataSource: SpaceDataSource,
  lookup: (dataSourceId: string) => SpaceDataSource | undefined,
  databaseName?: (dataSourceId: string) => string | undefined,
): FormulaSchema {
  const cache = new Map<string, ReadonlyArray<FormulaProperty>>();
  const of = (source: SpaceDataSource) => Object.values(source.properties).map(formulaProperty);
  return {
    dataSourceId: dataSource.id,
    properties: of(dataSource),
    source: (id) => {
      const hit = cache.get(id);
      if (hit !== undefined) return hit;
      const found = id === dataSource.id ? dataSource : lookup(id);
      if (found === undefined) return undefined;
      const properties = of(found);
      cache.set(id, properties);
      return properties;
    },
    ...(databaseName === undefined ? {} : { databaseName }),
  };
}

/** Data source ids that formulas of `dataSource` may reach: its relation targets. */
export function relationTargetIds(dataSource: SpaceDataSource): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const property of Object.values(dataSource.properties)) {
    if (property.type !== "relation") continue;
    const target = relationTarget(property);
    if (target !== undefined && target !== dataSource.id) ids.add(target);
  }
  return [...ids];
}

/**
 * Own-row properties a computed property reads, directly or through other computed properties.
 * An edit to any of them can change the value, so a view showing it must refresh.
 */
export function computedInputs(
  dataSource: SpaceDataSource,
  propertyId: SpacePropertyId,
): ReadonlySet<SpacePropertyId> {
  const closure = new Set<SpacePropertyId>();
  const visit = (id: SpacePropertyId) => {
    const property = dataSource.properties[id];
    if (property === undefined) return;
    for (const input of property.computed?.inputs ?? []) {
      if (closure.has(input) || input === propertyId) continue;
      closure.add(input);
      visit(input);
    }
  };
  visit(propertyId);
  return closure;
}

/** The value when it is one of the shapes this client renders; undefined for future types. */
export function knownComputedValue(
  value: unknown,
): typeof SpaceKnownComputedValue.Type | undefined {
  return Option.getOrUndefined(decodeComputedValue(value));
}

/** The type a known property filters, sorts and groups as; undefined for display-only computed ones. */
export function knownQueryType(known: SpaceKnownDatabaseProperty): string | undefined {
  return known.type === "formula" || known.type === "rollup"
    ? computedInfoOf(known)?.queryType
    : known.type;
}
