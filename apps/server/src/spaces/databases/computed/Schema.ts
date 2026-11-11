import * as C from "@t2code/contracts/spaces";
import type { FormulaProperty, FormulaSchema, FormulaType } from "@t2code/shared/formula";
import * as Effect from "effect/Effect";

import * as RelationStore from "../RelationStore.ts";
import * as SchemaStore from "../SchemaStore.ts";
import type { Property, Snapshot } from "../SchemaStore.ts";

/** The formula type of a property's value (plan table 1.4). */
export const formulaTypeOf = (property: Property): FormulaType => {
  if (property.type === "relation")
    return { list: { page: RelationStore.relationOf(property).dataSourceId } };
  if (property.type === "formula" || property.type === "rollup")
    return property.computed === null || property.computed.error !== undefined
      ? "any"
      : property.computed.type;
  const scalar: FormulaType | undefined = (
    C.SPACE_FORMULA_TYPE_BY_PROPERTY as Partial<Record<C.SpacePropertyType, FormulaType>>
  )[property.type];
  return scalar ?? "any";
};

const formulaProperty = (property: Property): FormulaProperty => ({
  id: property.id,
  name: property.name,
  type: formulaTypeOf(property),
  ...(property.type === "relation"
    ? { relationTo: RelationStore.relationOf(property).dataSourceId }
    : {}),
  ...(property.computed?.volatile === true ? { volatile: true } : {}),
  ...(property.computed?.error === undefined ? {} : { broken: true }),
  ...(property.deletedAtMs === null ? {} : { deleted: true }),
});

/** Snapshots of every other data source a relation of `snapshot` points at. */
export const loadOthers = Effect.fn("SpacesDatabases.loadRelatedSchemas")(function* (
  snapshot: Snapshot,
) {
  const own = snapshot.source.data_source_id;
  const others = new Map<string, Snapshot>();
  for (const property of snapshot.live) {
    if (property.type !== "relation") continue;
    const { dataSourceId } = RelationStore.relationOf(property);
    if (dataSourceId === own || others.has(dataSourceId)) continue;
    const loaded = yield* SchemaStore.load(dataSourceId).pipe(Effect.option);
    if (loaded._tag === "Some") others.set(dataSourceId, loaded.value);
  }
  return others;
});

export const forSource = (
  snapshot: Snapshot,
  others: ReadonlyMap<string, Snapshot>,
): FormulaSchema => {
  const own = snapshot.source.data_source_id;
  const cache = new Map<string, ReadonlyArray<FormulaProperty>>();
  return {
    dataSourceId: own,
    properties: snapshot.all.map(formulaProperty),
    source: (id) => {
      const hit = cache.get(id);
      if (hit !== undefined) return hit;
      const found = id === own ? snapshot : others.get(id);
      if (found === undefined) return undefined;
      const properties = found.all.map(formulaProperty);
      cache.set(id, properties);
      return properties;
    },
    databaseName: (id) => (id === own ? snapshot : others.get(id))?.source.name,
  };
};
