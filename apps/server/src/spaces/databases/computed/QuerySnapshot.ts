import type { Property, Snapshot } from "../SchemaStore.ts";
import { queryTypeOf } from "./Record.ts";

/**
 * The snapshot the query compiler and view validation see: each queryable formula or rollup is
 * replaced by a copy of the stored type its value is encoded as. Volatile properties and ones in
 * error keep their own type and are refused as not queryable, as before.
 */
export const of = (snapshot: Snapshot): Snapshot => {
  if (!snapshot.live.some((property) => property.computed !== null)) return snapshot;
  const swap = (property: Property): Property => {
    if (property.type !== "formula" && property.type !== "rollup") return property;
    const type = queryTypeOf(property.computed);
    return type === undefined ? property : { ...property, type, options: [], config: {} };
  };
  const all = snapshot.all.map(swap);
  return {
    source: snapshot.source,
    all,
    byId: new Map(all.map((property) => [property.id, property])),
    live: all.filter((property) => property.deletedAtMs === null),
  };
};
