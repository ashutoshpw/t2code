import * as Effect from "effect/Effect";

import * as SpacesSql from "../../SpacesSql.ts";
import type { Touched } from "../Touched.ts";
import * as Deps from "./Deps.ts";

/** Queues one row of a data source (never a template). */
export const enqueueRow = Effect.fn("SpacesDatabases.enqueueRow")(function* (pageId: string) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`INSERT OR IGNORE INTO spaces_db_computed_dirty (page_id, data_source_id)
    SELECT page_id, data_source_id FROM spaces_pages
    WHERE page_id = ${pageId} AND data_source_id IS NOT NULL AND row_template = 0`;
});

/** Queues every live row of a data source: a definition or input schema changed. */
export const enqueueSource = Effect.fn("SpacesDatabases.enqueueSource")(function* (
  dataSourceId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`INSERT OR IGNORE INTO spaces_db_computed_dirty (page_id, data_source_id)
    SELECT page_id, data_source_id FROM spaces_pages
    WHERE data_source_id = ${dataSourceId} AND row_template = 0 AND trash_batch_id IS NULL`;
});

/** Queues the rows of `referrerSource` that hold `targetPageId` in the relation `via`. */
export const enqueueReferrers = Effect.fn("SpacesDatabases.enqueueReferrers")(function* (
  referrerSource: string,
  via: string,
  targetPageId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`INSERT OR IGNORE INTO spaces_db_computed_dirty (page_id, data_source_id)
    SELECT c.page_id, c.data_source_id FROM spaces_db_cells c
    JOIN spaces_pages p ON p.page_id = c.page_id AND p.row_template = 0 AND p.trash_batch_id IS NULL
    WHERE c.ref = ${targetPageId} AND c.data_source_id = ${referrerSource} AND c.property_id = ${via}`;
});

/** Queues every row that holds one of `pageIds` through any relation some computed property reads across. */
export const enqueueReferrersOfPages = Effect.fn("SpacesDatabases.enqueueReferrersOfPages")(
  function* (pageIds: readonly string[]) {
    const sql = yield* SpacesSql.SpacesSql;
    for (let start = 0; start < pageIds.length; start += 200) {
      const chunk = pageIds.slice(start, start + 200);
      yield* sql`INSERT OR IGNORE INTO spaces_db_computed_dirty (page_id, data_source_id)
        SELECT c.page_id, c.data_source_id FROM spaces_db_cells c
        JOIN (SELECT DISTINCT data_source_id AS ds, via_property_id AS via FROM spaces_db_computed_deps
          WHERE via_property_id != '') v ON v.ds = c.data_source_id AND v.via = c.property_id
        JOIN spaces_pages p ON p.page_id = c.page_id AND p.row_template = 0 AND p.trash_batch_id IS NULL
        WHERE c.ref IN ${sql.in(chunk)}`;
    }
  },
);

/**
 * Turns what a mutation touched into queued rows (plan 2.5, rules 1 and 2): the row itself when
 * a computed property reads a changed property, and every row that reads the touched row through
 * a relation.
 */
export const settle = Effect.fn("SpacesDatabases.settleDirty")(function* (touched: Touched) {
  const sql = yield* SpacesSql.SpacesSql;
  const ownReads = new Map<string, ReadonlySet<string>>();
  const editedTime = new Map<string, readonly string[]>();
  const dependents = new Map<string, readonly Deps.Dependent[]>();
  const ownReadsOf = Effect.fn("SpacesDatabases.ownReads")(function* (dataSourceId: string) {
    const hit = ownReads.get(dataSourceId);
    if (hit !== undefined) return hit;
    const rows = yield* sql<{
      readonly dep_property_id: string;
    }>`SELECT DISTINCT dep_property_id FROM spaces_db_computed_deps
      WHERE data_source_id = ${dataSourceId} AND via_property_id = '' AND dep_data_source_id = ${dataSourceId}`;
    const found = new Set(rows.map((row) => row.dep_property_id));
    ownReads.set(dataSourceId, found);
    return found;
  });
  const editedTimeOf = Effect.fn("SpacesDatabases.editedTimeProperties")(function* (
    dataSourceId: string,
  ) {
    const hit = editedTime.get(dataSourceId);
    if (hit !== undefined) return hit;
    const rows = yield* sql<{
      readonly property_id: string;
    }>`SELECT property_id FROM spaces_db_properties
      WHERE data_source_id = ${dataSourceId} AND type = 'last_edited_time' AND deleted_at_ms IS NULL`;
    const found = rows.map((row) => row.property_id);
    editedTime.set(dataSourceId, found);
    return found;
  });
  const dependentsOf = Effect.fn("SpacesDatabases.cachedDependents")(function* (
    dataSourceId: string,
    propertyId: string,
  ) {
    const key = `${dataSourceId}\u0000${propertyId}`;
    const hit = dependents.get(key);
    if (hit !== undefined) return hit;
    const found = yield* Deps.dependentsOf(dataSourceId, propertyId);
    dependents.set(key, found);
    return found;
  });
  const computedSources = new Map<string, boolean>();
  for (const [pageId, dataSourceId] of touched.created) {
    let has = computedSources.get(dataSourceId);
    if (has === undefined) {
      const [any] = yield* sql`SELECT 1 FROM spaces_db_properties
        WHERE data_source_id = ${dataSourceId} AND computed IS NOT NULL AND deleted_at_ms IS NULL LIMIT 1`;
      has = any !== undefined;
      computedSources.set(dataSourceId, has);
    }
    if (has) yield* enqueueRow(pageId);
  }
  for (const [pageId, { dataSourceId, properties }] of touched.cells) {
    const changed = new Set(properties);
    if (changed.size > 0) for (const id of yield* editedTimeOf(dataSourceId)) changed.add(id);
    const reads = yield* ownReadsOf(dataSourceId);
    if ([...changed].some((id) => reads.has(id))) yield* enqueueRow(pageId);
    const pairs = new Set<string>();
    for (const id of changed)
      for (const dependent of yield* dependentsOf(dataSourceId, id))
        if (dependent.via_property_id !== "")
          pairs.add(`${dependent.data_source_id}\u0000${dependent.via_property_id}`);
    for (const pair of pairs) {
      const [referrerSource, via] = pair.split("\u0000");
      yield* enqueueReferrers(referrerSource!, via!, pageId);
    }
  }
});
