import type { FormulaDeps } from "@t2code/shared/formula";
import * as Effect from "effect/Effect";

import * as SpacesSql from "../../SpacesSql.ts";

export interface Dependent {
  readonly data_source_id: string;
  readonly property_id: string;
  readonly via_property_id: string;
}

/** Replaces the dependency rows of one computed property. */
export const write = Effect.fn("SpacesDatabases.writeDeps")(function* (
  dataSourceId: string,
  propertyId: string,
  deps: FormulaDeps,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`DELETE FROM spaces_db_computed_deps WHERE data_source_id = ${dataSourceId} AND property_id = ${propertyId}`;
  for (const own of new Set(deps.own))
    yield* sql`INSERT OR IGNORE INTO spaces_db_computed_deps (data_source_id, property_id, via_property_id, dep_data_source_id, dep_property_id)
      VALUES (${dataSourceId}, ${propertyId}, '', ${dataSourceId}, ${own})`;
  for (const related of deps.related)
    for (const target of new Set(related.propertyIds))
      yield* sql`INSERT OR IGNORE INTO spaces_db_computed_deps (data_source_id, property_id, via_property_id, dep_data_source_id, dep_property_id)
        VALUES (${dataSourceId}, ${propertyId}, ${related.relationPropertyId}, ${related.dataSourceId}, ${target})`;
});

export const clear = Effect.fn("SpacesDatabases.clearDeps")(function* (
  dataSourceId: string,
  propertyId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`DELETE FROM spaces_db_computed_deps WHERE data_source_id = ${dataSourceId} AND property_id = ${propertyId}`;
});

/** The computed properties that read `(depSource, depProperty)`, and through which relation. */
export const dependentsOf = Effect.fn("SpacesDatabases.dependentsOf")(function* (
  depSource: string,
  depProperty: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  return yield* sql<Dependent>`SELECT data_source_id, property_id, via_property_id FROM spaces_db_computed_deps
    WHERE dep_data_source_id = ${depSource} AND dep_property_id = ${depProperty}`;
});

/** The data sources holding a computed property that reads anything of `depSource`. */
export const sourcesReading = Effect.fn("SpacesDatabases.sourcesReading")(function* (
  depSource: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const rows = yield* sql<{
    readonly data_source_id: string;
  }>`SELECT DISTINCT data_source_id FROM spaces_db_computed_deps WHERE dep_data_source_id = ${depSource}`;
  return rows.map((row) => row.data_source_id);
});

/** What the property reads, as stored. */
export const depsOf = Effect.fn("SpacesDatabases.depsOf")(function* (
  dataSourceId: string,
  propertyId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  return yield* sql<{
    readonly dep_data_source_id: string;
    readonly dep_property_id: string;
  }>`SELECT dep_data_source_id, dep_property_id FROM spaces_db_computed_deps
    WHERE data_source_id = ${dataSourceId} AND property_id = ${propertyId}`;
});
