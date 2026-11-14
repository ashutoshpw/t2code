import * as Effect from "effect/Effect";

import { databaseLimits, ensureDatabaseLimit } from "../CorePolicy.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as CellStore from "./CellStore.ts";
import { refItem } from "./CellCodec.ts";
import * as DatabaseStore from "./DatabaseStore.ts";
import { fold, truncateBytes } from "./Fold.ts";
import * as Liveness from "./Liveness.ts";
import * as SchemaStore from "./SchemaStore.ts";
import type { Property, Snapshot } from "./SchemaStore.ts";
import { type Touched, recordCell } from "./Touched.ts";
import { dbError, isoNow } from "./Types.ts";
import * as ViewStore from "./ViewStore.ts";
import { clientIdPattern } from "./Ids.ts";

const refsOf = Effect.fn("SpacesDatabases.refsOf")(function* (pageId: string, propertyId: string) {
  return (yield* CellStore.cellsOf(pageId, propertyId)).flatMap((row) =>
    row.ref === null ? [] : [row.ref],
  );
});

export const relationOf = (property: Property) => SchemaStore.relationConfig(property);

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** The live twin of a two-way relation, or undefined for one-way, soft-deleted or non-reciprocal. */
export const loadTwin = Effect.fn("SpacesDatabases.loadTwin")(function* (
  property: Property,
  ownerSourceId: string,
) {
  const { dataSourceId, twinId } = relationOf(property);
  if (twinId === null) return undefined;
  const sql = yield* SpacesSql.SpacesSql;
  const [exists] =
    yield* sql`SELECT 1 FROM spaces_db_data_sources WHERE data_source_id = ${dataSourceId}`;
  if (!exists) return undefined;
  const snapshot = yield* SchemaStore.load(dataSourceId);
  const twin = snapshot.byId.get(twinId);
  if (!twin || twin.deletedAtMs !== null || twin.type !== "relation") return undefined;
  const back = relationOf(twin);
  return back.twinId === property.id && back.dataSourceId === ownerSourceId
    ? { snapshot, twin }
    : undefined;
});

const touch = (touched: Touched, pageId: string, dataSourceId: string, propertyId: string) => {
  touched.rows.set(pageId, dataSourceId);
  touched.sources.add(dataSourceId);
  recordCell(touched, pageId, dataSourceId, propertyId);
};

/** Every target must be a live, non-template row of the target data source. */
const checkTargets = Effect.fn("SpacesDatabases.checkTargets")(function* (
  targetSource: string,
  targets: readonly string[],
  propertyId: string,
) {
  if (targets.length === 0) return;
  const sql = yield* SpacesSql.SpacesSql;
  const found = yield* sql<{ readonly page_id: string }>`SELECT page_id FROM spaces_pages
    WHERE page_id IN ${sql.in(targets)} AND data_source_id = ${targetSource}
    AND trash_batch_id IS NULL AND row_template = 0`;
  if (found.length !== targets.length) return yield* dbError("invalid_relation_target", propertyId);
});

/** The parent chain of `start` through the sub-items property reaches `row`, or is too deep. */
const reachesRow = Effect.fn("SpacesDatabases.reachesRow")(function* (
  start: string,
  row: string,
  parentProperty: string,
) {
  let current = start;
  for (let hop = 0; hop <= databaseLimits.maxSubItemDepth; hop++) {
    if (current === row) return true;
    const [parent] = yield* refsOf(current, parentProperty);
    if (parent === undefined) return false;
    current = parent;
  }
  return true;
});

/** Pages among `ids` that reads still show: not trashed. */
const visibleAmong = Effect.fn("SpacesDatabases.visibleAmong")(function* (ids: readonly string[]) {
  if (ids.length === 0) return new Set<string>();
  const sql = yield* SpacesSql.SpacesSql;
  const found = yield* sql<{
    readonly page_id: string;
  }>`SELECT page_id FROM spaces_pages WHERE page_id IN ${sql.in(ids)} AND trash_batch_id IS NULL`;
  return new Set(found.map((row) => row.page_id));
});

/**
 * Sets what the writer sees of `(row, property)` to `targets`, keeping a two-way twin mirrored in
 * the same transaction. Links to trashed rows are invisible to the writer and survive the edit,
 * unless `limit: one` makes the new target replace them. Returns whether the stored value changed.
 */
export const write = Effect.fn("SpacesDatabases.writeRelation")(function* (input: {
  readonly snapshot: Snapshot;
  readonly property: Property;
  readonly pageId: string;
  readonly targets: readonly string[];
  readonly touched: Touched;
}) {
  const { snapshot, property, pageId, targets, touched } = input;
  const sourceId = snapshot.source.data_source_id;
  const config = relationOf(property);
  const stored = yield* refsOf(pageId, property.id);
  const visible = yield* visibleAmong(stored);
  const seen = stored.filter((id) => visible.has(id));
  if (sameList(seen, targets)) return false;
  if (config.limit === "one" && targets.length > 1)
    return yield* dbError("relation_limit", property.id);
  yield* checkTargets(config.dataSourceId, targets, property.id);
  if (snapshot.source.sub_items_property_id === property.id)
    for (const target of targets)
      if (yield* reachesRow(target, pageId, property.id))
        return yield* dbError("cycle", property.id);
  const kept =
    config.limit === "one" && targets.length > 0 ? [] : stored.filter((id) => !visible.has(id));
  const next = [...targets, ...kept];
  if (next.length > databaseLimits.maxCellItems)
    return yield* dbError("relation_limit", property.id);
  const twinRef = yield* loadTwin(property, sourceId);
  const twinSource = config.dataSourceId;
  if (twinRef) {
    const { twin, snapshot: twinSnapshot } = twinRef;
    if (twinSnapshot.source.sub_items_property_id === twin.id)
      for (const child of targets.filter((id) => !stored.includes(id)))
        if (yield* reachesRow(pageId, child, twin.id)) return yield* dbError("cycle", property.id);
  }
  yield* CellStore.replace(pageId, sourceId, property.id, next.map(refItem));
  touch(touched, pageId, sourceId, property.id);
  if (!twinRef) return true;
  const { twin } = twinRef;
  const twinLimit = relationOf(twin).limit;
  for (const removed of stored.filter((id) => !next.includes(id))) {
    const refs = yield* refsOf(removed, twin.id);
    yield* CellStore.replace(
      removed,
      twinSource,
      twin.id,
      refs.filter((id) => id !== pageId).map(refItem),
    );
    touch(touched, removed, twinSource, twin.id);
  }
  for (const added of targets.filter((id) => !stored.includes(id))) {
    const refs = yield* refsOf(added, twin.id);
    if (refs.includes(pageId)) continue;
    if (twinLimit === "one" && refs.length > 0) {
      const [displaced] = refs;
      const theirs = yield* refsOf(displaced!, property.id);
      yield* CellStore.replace(
        displaced!,
        sourceId,
        property.id,
        theirs.filter((id) => id !== added).map(refItem),
      );
      touch(touched, displaced!, sourceId, property.id);
      yield* CellStore.replace(added, twinSource, twin.id, [refItem(pageId)]);
    } else {
      if (refs.length + 1 > databaseLimits.maxCellItems)
        return yield* dbError("relation_limit", twin.id);
      yield* CellStore.replace(added, twinSource, twin.id, [...refs, pageId].map(refItem));
    }
    touch(touched, added, twinSource, twin.id);
  }
  return true;
});

/** The sub-items settings of a data source need a two-way self-relation with limit one. */
export const checkSubItemsParent = Effect.fn("SpacesDatabases.checkSubItemsParent")(function* (
  snapshot: Snapshot,
  parent: Property,
) {
  const config = relationOf(parent);
  const sourceId = snapshot.source.data_source_id;
  const twin = config.twinId === null ? undefined : snapshot.byId.get(config.twinId);
  if (
    parent.type !== "relation" ||
    config.dataSourceId !== sourceId ||
    config.limit !== "one" ||
    !twin ||
    twin.deletedAtMs !== null
  )
    return yield* dbError("invalid_property_config", parent.id);
  return twin;
});

/** The data source a relation points at must be live and in the same space. */
export const checkTarget = Effect.fn("SpacesDatabases.checkRelationTarget")(function* (
  snapshot: Snapshot,
  targetId: string,
  propertyId?: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<{
    readonly database_id: string;
    readonly space_id: string;
  }>`SELECT s.database_id, d.space_id FROM spaces_db_data_sources s
    JOIN spaces_db_databases d ON d.database_id = s.database_id WHERE s.data_source_id = ${targetId}`;
  if (!row) return yield* dbError("invalid_property_config", propertyId);
  const [own] = yield* sql<{
    readonly space_id: string;
  }>`SELECT d.space_id FROM spaces_db_databases d WHERE d.database_id = ${snapshot.source.database_id}`;
  if (row.space_id !== own?.space_id) return yield* dbError("invalid_relation_target", propertyId);
  if (row.database_id !== snapshot.source.database_id)
    yield* Liveness.assertDatabaseLive(row.database_id);
});

const uniqueName = (taken: readonly Property[], base: string) => {
  const keys = new Set(taken.filter((p) => p.deletedAtMs === null).map((p) => fold(p.name)));
  const clean = truncateBytes(base.trim() || "Relation", databaseLimits.maxNameBytes - 8);
  for (let n = 1; ; n++) {
    const name = n === 1 ? clean : `${clean} ${n}`;
    if (!keys.has(fold(name))) return name;
  }
};

/** Creates the synced property `twinId` on the target and backfills it from existing cells. */
export const createTwin = Effect.fn("SpacesDatabases.createTwin")(function* (input: {
  readonly source: Snapshot;
  readonly property: Property;
  readonly twinId: string;
  readonly now: number;
  readonly touched: Touched;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  const sourceId = input.source.source.data_source_id;
  const config = relationOf(input.property);
  const target = yield* SchemaStore.load(config.dataSourceId);
  if (
    !clientIdPattern.test(input.twinId) ||
    target.byId.has(input.twinId) ||
    (config.dataSourceId === sourceId && input.twinId === input.property.id)
  )
    return yield* dbError("invalid_property_config", input.property.id);
  yield* ensureDatabaseLimit("maxPropertiesPerDataSource", target.live.length + 1);
  yield* SchemaStore.insertProperty({
    dataSourceId: config.dataSourceId,
    id: input.twinId,
    name: uniqueName(target.all, input.source.source.name),
    type: "relation",
    config: { dataSourceId: sourceId, limit: "many", twoWay: { propertyId: input.property.id } },
    position: SchemaStore.endPosition(target),
  });
  yield* DatabaseStore.bumpSchema(config.dataSourceId, isoNow(input.now));
  input.touched.schema.add(config.dataSourceId);
  input.touched.sources.add(config.dataSourceId);
  const [widest] = yield* sql<{
    readonly widest: number | null;
  }>`SELECT MAX(n) AS widest FROM (SELECT COUNT(*) AS n FROM spaces_db_cells
    WHERE data_source_id = ${sourceId} AND property_id = ${input.property.id} GROUP BY ref)`;
  yield* ensureDatabaseLimit("maxCellItems", widest?.widest ?? 0);
  yield* sql`INSERT INTO spaces_db_cells (page_id, property_id, ord, data_source_id, ref)
    SELECT c.ref, ${input.twinId},
      row_number() OVER (PARTITION BY c.ref ORDER BY p.row_position, p.row_seq, p.page_id) - 1,
      ${config.dataSourceId}, c.page_id
    FROM spaces_db_cells c JOIN spaces_pages p ON p.page_id = c.page_id
    WHERE c.data_source_id = ${sourceId} AND c.property_id = ${input.property.id} AND c.ref IS NOT NULL`;
});

/** Soft-deletes a twin in another (or the same) data source, as removeProperty would. */
export const removeTwin = Effect.fn("SpacesDatabases.removeTwin")(function* (input: {
  readonly snapshot: Snapshot;
  readonly twin: Property;
  readonly now: number;
  readonly touched: Touched;
}) {
  const sourceId = input.snapshot.source.data_source_id;
  const iso = isoNow(input.now);
  yield* SchemaStore.setDeleted(sourceId, input.twin.id, input.now);
  yield* ViewStore.strip(
    sourceId,
    { propertyId: input.twin.id, column: true, filters: true, sorts: true, groups: true },
    iso,
  );
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_db_data_sources SET sub_items_property_id = NULL
    WHERE data_source_id = ${sourceId} AND sub_items_property_id = ${input.twin.id}`;
  yield* DatabaseStore.bumpSchema(sourceId, iso);
  input.touched.schema.add(sourceId);
});

/** Cell rows elsewhere that point at pages about to be permanently deleted. */
export const purgeInbound = Effect.fn("SpacesDatabases.purgeInbound")(function* (
  pageIds: readonly string[],
) {
  const sql = yield* SpacesSql.SpacesSql;
  const sources = new Set<string>();
  for (let start = 0; start < pageIds.length; start += 200) {
    const chunk = pageIds.slice(start, start + 200);
    const owners = yield* sql<{
      readonly data_source_id: string;
    }>`SELECT DISTINCT data_source_id FROM spaces_db_cells WHERE ref IN ${sql.in(chunk)}`;
    for (const owner of owners) sources.add(owner.data_source_id);
    yield* sql`DELETE FROM spaces_db_cells WHERE ref IN ${sql.in(chunk)}`;
  }
  return sources;
});
