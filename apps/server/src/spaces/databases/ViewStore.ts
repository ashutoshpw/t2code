import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { byteLength, canonical, ensureDatabaseLimit, maxDatabaseViewBytes } from "../CorePolicy.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as Ids from "./Ids.ts";
import { type Json, type JsonObject, isObject, parseJson } from "./Json.ts";
import { placeInList } from "./Position.ts";
import { appendPosition } from "./Position.ts";
import type { Snapshot } from "./SchemaStore.ts";
import { liveProperty } from "./SchemaStore.ts";
import { type ViewRecord, dbError, notFound } from "./Types.ts";
import * as QuerySnapshot from "./computed/QuerySnapshot.ts";
import * as Validation from "./ViewValidation.ts";

const decodeView = Schema.decodeUnknownSync(C.SpaceDatabaseView);
const decodeColumn = Schema.decodeUnknownSync(C.SpaceKnownViewProperty);

export const getView = Effect.fn("SpacesDatabases.getView")(function* (id: string) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<ViewRecord>`SELECT * FROM spaces_db_views WHERE view_id = ${id}`;
  if (!row) return yield* notFound("view", id);
  return row;
});

export const viewsOfDatabase = Effect.fn("SpacesDatabases.viewsOfDatabase")(function* (
  databaseId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  return yield* sql<ViewRecord>`SELECT * FROM spaces_db_views WHERE database_id = ${databaseId}
    ORDER BY position, view_id`;
});

export const viewsOfSource = Effect.fn("SpacesDatabases.viewsOfSource")(function* (
  dataSourceId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  return yield* sql<ViewRecord>`SELECT * FROM spaces_db_views WHERE data_source_id = ${dataSourceId}`;
});

/** A view write may not push the database's views past the bound that keeps `getDatabase` readable. */
const ensureViewBytes = Effect.fn("SpacesDatabases.ensureViewBytes")(function* (
  databaseId: string,
  viewId: string | null,
  bytes: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const [others] = yield* sql<{
    readonly total: number;
  }>`SELECT COALESCE(SUM(logical_bytes), 0) AS total FROM spaces_db_views
    WHERE database_id = ${databaseId} AND view_id IS NOT ${viewId}`;
  const total = (others?.total ?? 0) + bytes;
  if (total > maxDatabaseViewBytes)
    return yield* new C.SpaceLimitExceededError({
      limit: "databases.maxViewBytes",
      actual: total,
      maximum: maxDatabaseViewBytes,
    });
});

export const wireView = (record: ViewRecord): C.SpaceDatabaseView =>
  decodeView({
    id: record.view_id,
    databaseId: record.database_id,
    dataSourceId: record.data_source_id,
    name: record.name,
    type: record.type,
    position: record.position,
    ...(record.filter === null ? {} : { filter: parseJson(record.filter) }),
    sorts: parseJson(record.sorts),
    ...(record.grouping === null ? {} : { group: parseJson(record.grouping) }),
    ...(record.sub_grouping === null ? {} : { subGroup: parseJson(record.sub_grouping) }),
    properties: parseJson(record.properties),
    layout: parseJson(record.layout),
    ...(record.owner_block_id === null ? {} : { ownerBlockId: record.owner_block_id }),
  });

interface ViewDefinition {
  readonly name: string;
  readonly type: C.SpaceViewType;
  readonly filter: C.SpaceKnownFilter | null;
  readonly sorts: readonly C.SpaceKnownSort[];
  readonly group: C.SpaceKnownGroup | null;
  readonly subGroup: C.SpaceKnownGroup | null;
  readonly properties: readonly C.SpaceKnownViewProperty[];
  readonly layout: Json;
}

/** Validates a whole definition against the schema and returns the layout as decoded. */
const validateDefinition = Effect.fn("SpacesDatabases.validateView")(function* (
  full: Snapshot,
  definition: ViewDefinition,
  layoutReferences = true,
) {
  const snapshot = QuerySnapshot.of(full);
  if (definition.filter) yield* Validation.validateFilter(snapshot, definition.filter);
  yield* Validation.validateSorts(snapshot, definition.sorts);
  if (definition.subGroup && !definition.group) return yield* dbError("invalid_view");
  if (definition.group) yield* Validation.validateGroup(snapshot, definition.group);
  if (definition.subGroup) {
    yield* Validation.validateGroup(snapshot, definition.subGroup);
    if (definition.subGroup.property === definition.group?.property)
      return yield* dbError("invalid_group", definition.subGroup.property);
  }
  const seen = new Set<string>();
  for (const column of definition.properties) {
    const property = yield* liveProperty(snapshot, column.propertyId);
    if (seen.has(property.id)) return yield* dbError("invalid_view", property.id);
    seen.add(property.id);
    if (column.aggregate !== undefined)
      yield* Validation.validateAggregate(property, column.aggregate);
  }
  return yield* Validation.validateLayout(
    snapshot,
    definition.type,
    definition.layout,
    layoutReferences,
  );
});

const columns = (record: ViewRecord) =>
  ({
    filter: record.filter,
    sorts: record.sorts,
    grouping: record.grouping,
    sub_grouping: record.sub_grouping,
    properties: record.properties,
    layout: record.layout,
  }) as const;

const serialize = (definition: ViewDefinition, layout: JsonObject) => ({
  filter: definition.filter === null ? null : canonical(definition.filter),
  sorts: canonical(definition.sorts),
  grouping: definition.group === null ? null : canonical(definition.group),
  sub_grouping: definition.subGroup === null ? null : canonical(definition.subGroup),
  properties: canonical(definition.properties),
  layout: canonical(layout),
});

export const createView = Effect.fn("SpacesDatabases.createView")(function* (input: {
  readonly snapshot: Snapshot;
  readonly databaseId: string;
  readonly definition: ViewDefinition;
  readonly beforeViewId: string | null;
  readonly ownerBlockId: string | null;
  readonly now: string;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  const name = input.definition.name.trim();
  if (name === "") return yield* new C.SpaceValidationError({ reason: "invalid_input" });
  yield* ensureDatabaseLimit("maxNameBytes", Buffer.byteLength(name, "utf8"));
  const existing = yield* viewsOfDatabase(input.databaseId);
  yield* ensureDatabaseLimit("maxViewsPerDatabase", existing.length + 1);
  const layout = yield* validateDefinition(input.snapshot, input.definition);
  const stored = serialize(input.definition, layout);
  const id = C.SpaceViewId.make(yield* Ids.register("view"));
  const placed =
    input.beforeViewId === null
      ? undefined
      : placeInList(
          existing.map((view) => ({ id: view.view_id, position: view.position })),
          [id],
          input.beforeViewId,
        );
  if (input.beforeViewId !== null && !placed) return yield* notFound("view", input.beforeViewId);
  const position =
    placed?.get(id) ?? appendPosition(existing[existing.length - 1]?.position ?? null);
  const draft = {
    name,
    type: input.definition.type,
    ...stored,
  };
  const wire = {
    view_id: id,
    database_id: C.SpaceDatabaseId.make(input.databaseId),
    data_source_id: input.snapshot.source.data_source_id,
    owner_block_id: input.ownerBlockId,
    position,
    created_at: input.now,
    updated_at: input.now,
    logical_bytes: 0,
    orphaned_at_ms: null,
    ...draft,
  } satisfies ViewRecord;
  const bytes = byteLength(wireView(wire));
  yield* ensureDatabaseLimit("maxViewBytes", bytes);
  yield* ensureViewBytes(input.databaseId, null, bytes);
  yield* sql`INSERT INTO spaces_db_views (view_id, database_id, data_source_id, owner_block_id, name, type, position, filter, sorts, grouping, sub_grouping, properties, layout, logical_bytes, created_at, updated_at)
    VALUES (${id}, ${input.databaseId}, ${wire.data_source_id}, ${input.ownerBlockId}, ${name}, ${draft.type}, ${position},
    ${draft.filter}, ${draft.sorts}, ${draft.grouping}, ${draft.sub_grouping}, ${draft.properties}, ${draft.layout}, ${bytes}, ${input.now}, ${input.now})`;
  if (placed)
    for (const [other, next] of placed)
      if (other !== id)
        yield* sql`UPDATE spaces_db_views SET position = ${next} WHERE view_id = ${other}`;
  return id;
});

const decodeViewType = Schema.decodeUnknownSync(C.SpaceViewType);
const decodeFilter = Schema.decodeUnknownSync(C.SpaceKnownFilter);
const decodeSorts = Schema.decodeUnknownSync(Schema.Array(C.SpaceKnownSort));
const decodeGroup = Schema.decodeUnknownSync(C.SpaceKnownGroup);
const decodeColumns = Schema.decodeUnknownSync(Schema.Array(C.SpaceKnownViewProperty));

const definitionOf = (record: ViewRecord): ViewDefinition => ({
  name: record.name,
  type: decodeViewType(record.type),
  filter: record.filter === null ? null : decodeFilter(parseJson(record.filter)),
  sorts: decodeSorts(parseJson(record.sorts)),
  group: record.grouping === null ? null : decodeGroup(parseJson(record.grouping)),
  subGroup: record.sub_grouping === null ? null : decodeGroup(parseJson(record.sub_grouping)),
  properties: decodeColumns(parseJson(record.properties)),
  layout: parseJson(record.layout),
});

/** Persists a changed definition; every field has already been validated by the caller. */
const save = Effect.fn("SpacesDatabases.saveView")(function* (
  record: ViewRecord,
  definition: ViewDefinition,
  layout: JsonObject,
  now: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const stored = serialize(definition, layout);
  const next = { ...record, name: definition.name, type: definition.type, ...stored };
  const bytes = byteLength(wireView(next));
  yield* ensureDatabaseLimit("maxViewBytes", bytes);
  // A view that does not grow stays savable in a database that is already over the bound.
  if (bytes > record.logical_bytes)
    yield* ensureViewBytes(record.database_id, record.view_id, bytes);
  yield* sql`UPDATE spaces_db_views SET name = ${definition.name}, type = ${definition.type}, filter = ${stored.filter},
    sorts = ${stored.sorts}, grouping = ${stored.grouping}, sub_grouping = ${stored.sub_grouping},
    properties = ${stored.properties}, layout = ${stored.layout}, logical_bytes = ${bytes}, updated_at = ${now}
    WHERE view_id = ${record.view_id}`;
});

interface ViewPatch {
  readonly name?: string;
  readonly type?: C.SpaceViewType;
  readonly filter?: C.SpaceKnownFilter | null;
  readonly sorts?: readonly C.SpaceKnownSort[];
  readonly group?: C.SpaceKnownGroup | null;
  readonly subGroup?: C.SpaceKnownGroup | null;
  readonly properties?: C.SpaceViewUpdateInput["properties"];
  readonly layout?: Json;
  readonly beforeViewId?: string | null | undefined;
}

export const updateView = Effect.fn("SpacesDatabases.updateView")(function* (input: {
  readonly snapshot: Snapshot;
  readonly record: ViewRecord;
  readonly patch: ViewPatch;
  readonly now: string;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  const { patch, record, snapshot } = input;
  const base = definitionOf(record);
  const name = patch.name === undefined ? base.name : patch.name.trim();
  if (name === "") return yield* new C.SpaceValidationError({ reason: "invalid_input" });
  yield* ensureDatabaseLimit("maxNameBytes", Buffer.byteLength(name, "utf8"));
  let columnsNext = base.properties;
  if (patch.properties?.set) {
    const next = new Map(columnsNext.map((column) => [column.propertyId, column]));
    for (const [id, change] of Object.entries(patch.properties.set)) {
      const property = yield* liveProperty(snapshot, id);
      if (change === null) {
        next.delete(C.SpacePropertyId.make(id));
        continue;
      }
      const current = next.get(C.SpacePropertyId.make(property.id));
      const { visible, width, wrap, aggregate } = change;
      const merged: Record<string, unknown> = {
        propertyId: property.id,
        visible: visible ?? current?.visible ?? true,
      };
      for (const [key, patched, old] of [
        ["width", width, current?.width],
        ["wrap", wrap, current?.wrap],
        ["aggregate", aggregate, current?.aggregate],
      ] as const) {
        const value = patched === undefined ? old : patched;
        if (value !== undefined && value !== null) merged[key] = value;
      }
      next.set(C.SpacePropertyId.make(property.id), decodeColumn(merged));
    }
    columnsNext = [...next.values()];
  }
  if (patch.properties?.order) {
    const order = patch.properties.order;
    if (new Set(order).size !== order.length) return yield* dbError("invalid_view");
    const byId = new Map(columnsNext.map((column) => [column.propertyId, column]));
    const head = [];
    for (const id of order) {
      const property = yield* liveProperty(snapshot, id);
      head.push(
        byId.get(id) ?? { propertyId: C.SpacePropertyId.make(property.id), visible: false },
      );
    }
    columnsNext = [...head, ...columnsNext.filter((column) => !order.includes(column.propertyId))];
  }
  const type = patch.type ?? base.type;
  let layout: Json = patch.layout ?? base.layout;
  if (patch.layout === undefined && patch.type !== undefined && patch.type !== base.type)
    layout = Validation.layoutDecoders[type](base.layout) ?? {};
  const definition: ViewDefinition = {
    name,
    type,
    filter: patch.filter === undefined ? base.filter : patch.filter,
    sorts: patch.sorts ?? base.sorts,
    group: patch.group === undefined ? base.group : patch.group,
    subGroup: patch.subGroup === undefined ? base.subGroup : patch.subGroup,
    properties: columnsNext,
    layout,
  };
  // A patch that leaves layout and type alone must not fail on a layout property removed since.
  const validLayout = yield* validateDefinition(
    snapshot,
    definition,
    patch.layout !== undefined || type !== base.type,
  );
  yield* save(record, definition, validLayout, input.now);
  if (patch.beforeViewId !== undefined) {
    const siblings = yield* viewsOfDatabase(record.database_id);
    const placed = placeInList(
      siblings.map((view) => ({ id: view.view_id, position: view.position })),
      [record.view_id],
      patch.beforeViewId,
    );
    if (!placed) return yield* notFound("view", patch.beforeViewId ?? record.view_id);
    for (const [id, position] of placed)
      yield* sql`UPDATE spaces_db_views SET position = ${position} WHERE view_id = ${id}`;
  }
});

export const deleteView = Effect.fn("SpacesDatabases.deleteView")(function* (record: ViewRecord) {
  const sql = yield* SpacesSql.SpacesSql;
  const siblings = yield* viewsOfDatabase(record.database_id);
  if (siblings.length <= 1) return yield* dbError("last_view");
  yield* sql`DELETE FROM spaces_db_views WHERE view_id = ${record.view_id}`;
  yield* Ids.retire(record.view_id);
});

type Node = C.SpaceKnownFilter;

/** Removes matching leaves, and any group they leave empty, so no group flips meaning. */
const prune = (
  node: Node,
  drop: (leaf: Extract<Node, { readonly property: C.SpacePropertyId }>) => boolean,
): Node | null => {
  const nested = Validation.children(node);
  if (nested === undefined) return Validation.isCondition(node) && drop(node) ? null : node;
  const kept = nested.flatMap((child) => {
    const next = prune(child, drop);
    return next === null ? [] : [next];
  });
  if (kept.length === 0 && nested.length > 0) return null;
  return "and" in node ? { and: kept } : { or: kept };
};

interface StripRules {
  readonly propertyId: string;
  readonly optionId?: string;
  /** Remove the column entry itself (property deleted), not just its aggregate. */
  readonly column: boolean;
  /** Remove filter conditions on the property whatever their value. */
  readonly filters: boolean;
  readonly sorts: boolean;
  readonly groups: boolean;
  /** The property is no longer a date: calendar and timeline views stop naming it. */
  readonly dateReference?: boolean;
}

/** Optional layout references (card preview property, timeline end) go with their property. */
const dropLayoutReferences = (
  layout: Json,
  type: C.SpaceViewType,
  rules: StripRules,
): JsonObject => {
  if (!isObject(layout)) return {};
  if (rules.optionId !== undefined) return layout;
  const next: Record<string, Json> = { ...layout };
  const preview = next.cardPreview;
  if (rules.column && isObject(preview) && preview.propertyId === rules.propertyId)
    delete next.cardPreview;
  if (type === "timeline" && next.endPropertyId === rules.propertyId) delete next.endPropertyId;
  if (rules.column) {
    const y = next.y;
    if (type === "chart" && isObject(y) && y.property === rules.propertyId) delete next.y;
    const questions = next.questions;
    if (type === "form" && Array.isArray(questions))
      next.questions = questions.filter(
        (question) => !(isObject(question) && question.propertyId === rules.propertyId),
      );
  }
  if (rules.column || rules.dateReference === true) {
    if (type === "calendar" && next.datePropertyId === rules.propertyId) delete next.datePropertyId;
    if (type === "timeline") {
      if (next.startPropertyId === rules.propertyId) delete next.startPropertyId;
      if (rules.dateReference === true && next.endPropertyId === rules.propertyId)
        delete next.endPropertyId;
    }
  }
  return next;
};

/** Applies the rules to every view of the data source in the current transaction. */
export const strip = Effect.fn("SpacesDatabases.stripViews")(function* (
  dataSourceId: string,
  rules: StripRules,
  now: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const records = yield* viewsOfSource(dataSourceId);
  let touched = 0;
  for (const record of records) {
    const before = definitionOf(record);
    const filter =
      before.filter === null
        ? null
        : prune(before.filter, (leaf) => {
            if (leaf.property !== rules.propertyId) return false;
            return rules.optionId === undefined ? rules.filters : leaf.value === rules.optionId;
          });
    const group = rules.groups && before.group?.property === rules.propertyId ? null : before.group;
    const subGroup =
      group === null || (rules.groups && before.subGroup?.property === rules.propertyId)
        ? null
        : before.subGroup;
    const columnsNext = rules.column
      ? before.properties.filter((column) => column.propertyId !== rules.propertyId)
      : rules.filters
        ? before.properties.map((column) => {
            if (column.propertyId !== rules.propertyId || column.aggregate === undefined)
              return column;
            const { aggregate: _dropped, ...rest } = column;
            return rest;
          })
        : before.properties;
    const next: ViewDefinition = {
      ...before,
      filter,
      sorts: rules.sorts
        ? before.sorts.filter((sort) => sort.property !== rules.propertyId)
        : before.sorts,
      group,
      subGroup,
      properties: columnsNext,
    };
    const stored = serialize(next, dropLayoutReferences(before.layout, before.type, rules));
    if (canonical(columns(record)) === canonical(stored)) continue;
    const bytes = byteLength(wireView({ ...record, ...stored }));
    yield* sql`UPDATE spaces_db_views SET filter = ${stored.filter}, sorts = ${stored.sorts}, grouping = ${stored.grouping},
      sub_grouping = ${stored.sub_grouping}, properties = ${stored.properties}, layout = ${stored.layout}, logical_bytes = ${bytes}, updated_at = ${now}
      WHERE view_id = ${record.view_id}`;
    touched++;
  }
  return touched;
});
