import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { ensureDatabaseLimit, databaseLimits } from "../CorePolicy.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as CellStore from "./CellStore.ts";
import * as Conversion from "./Conversion.ts";
import * as DatabaseStore from "./DatabaseStore.ts";
import { fold } from "./Fold.ts";
import { clientIdPattern, shortId } from "./Ids.ts";
import { type Json, type JsonObject, isObject } from "./Json.ts";
import { normalizeConfig, optionTypes } from "./PropertyConfig.ts";
import * as Definitions from "./computed/Definitions.ts";
import * as RelationStore from "./RelationStore.ts";
import * as SchemaStore from "./SchemaStore.ts";
import type { Property, Snapshot } from "./SchemaStore.ts";
import type { Touched } from "./Touched.ts";
import { type OptionRecord, dbError, isoNow, notFound } from "./Types.ts";
import * as ViewStore from "./ViewStore.ts";

type Draft = C.SpacePropertyDraft;
export interface Context {
  readonly dataSourceId: string;
  readonly now: number;
  readonly touched: Touched;
}
const iso = (ctx: Context) => isoNow(ctx.now);

const reload = (ctx: Context) => SchemaStore.load(ctx.dataSourceId);

const stripStatusDefault = (
  config: JsonObject,
  optionIds: readonly string[],
  propertyId: string,
) =>
  typeof config.defaultOptionId === "string" && !optionIds.includes(config.defaultOptionId)
    ? dbError("invalid_property_config", propertyId)
    : Effect.void;

/** Adds one property (and, for a two-way relation, its synced twin). Returns the new id. */
export const addProperty = Effect.fn("SpacesDatabases.addProperty")(function* (
  ctx: Context,
  draft: Draft,
  beforePropertyId: string | null = null,
) {
  const snapshot = yield* reload(ctx);
  if (draft.type === "title") return yield* dbError("title_property");
  const name = yield* DatabaseStore.validName(draft.name);
  yield* SchemaStore.nameFree(snapshot, name);
  yield* ensureDatabaseLimit("maxPropertiesPerDataSource", snapshot.live.length + 1);
  if (draft.type === "unique_id" && snapshot.live.some((p) => p.type === "unique_id"))
    return yield* dbError("invalid_property_config");
  let id: string;
  if (draft.id !== undefined) {
    if (
      !clientIdPattern.test(draft.id) ||
      draft.id === C.SPACE_TITLE_PROPERTY_ID ||
      snapshot.byId.has(draft.id)
    )
      return yield* dbError("invalid_property_config", draft.id);
    id = draft.id;
  } else id = shortId(new Set(snapshot.byId.keys()));
  if (draft.options !== undefined && !optionTypes.has(draft.type))
    return yield* dbError("invalid_property_config", id);
  const config = yield* normalizeConfig(draft.type, draft.config, id);
  if (draft.type === "relation")
    yield* RelationStore.checkTarget(snapshot, String(config.dataSourceId), id);
  const optionDrafts =
    draft.type === "status" && (draft.options ?? []).length === 0
      ? SchemaStore.defaultStatusOptions
      : (draft.options ?? []);
  const sql = yield* SpacesSql.SpacesSql;
  yield* SchemaStore.insertProperty({
    dataSourceId: ctx.dataSourceId,
    id,
    name,
    type: draft.type,
    config,
    description: draft.description,
    position: SchemaStore.endPosition(snapshot),
  });
  const optionIds: string[] = [];
  if (optionTypes.has(draft.type)) {
    let current: readonly OptionRecord[] = [];
    for (const optionDraft of optionDrafts) {
      const property: Property = {
        id,
        name,
        type: draft.type,
        config: {},
        description: null,
        position: 0,
        deletedAtMs: null,
        options: current,
        computed: null,
      };
      const optionId = yield* SchemaStore.addOption(ctx.dataSourceId, property, optionDraft);
      optionIds.push(optionId);
      current =
        yield* sql<OptionRecord>`SELECT * FROM spaces_db_options WHERE data_source_id = ${ctx.dataSourceId}
        AND property_id = ${id} ORDER BY position, option_id`;
    }
    if (draft.type === "status") {
      if (draft.options === undefined || draft.options.length === 0)
        yield* SchemaStore.setConfig(ctx.dataSourceId, id, { defaultOptionId: optionIds[0]! });
      else yield* stripStatusDefault(config, optionIds, id);
    }
  }
  if (beforePropertyId !== null) {
    const fresh = yield* reload(ctx);
    yield* SchemaStore.liveProperty(fresh, beforePropertyId);
    yield* SchemaStore.movePositions(fresh, id, beforePropertyId);
  }
  if (draft.type === "relation") {
    const twinId = RelationStore.relationOf({
      id,
      name,
      type: "relation",
      config,
      description: null,
      position: 0,
      deletedAtMs: null,
      options: [],
      computed: null,
    }).twinId;
    if (twinId !== null) {
      const fresh = yield* reload(ctx);
      yield* RelationStore.createTwin({
        source: fresh,
        property: fresh.byId.get(id)!,
        twinId,
        now: ctx.now,
        touched: ctx.touched,
      });
    }
  }
  if (draft.type === "formula" || draft.type === "rollup") yield* Definitions.define(ctx, id);
  return id;
});

const updateRelation = Effect.fn("SpacesDatabases.updateRelation")(function* (
  ctx: Context,
  snapshot: Snapshot,
  property: Property,
  raw: Json,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const next = yield* normalizeConfig("relation", raw, property.id);
  const old = RelationStore.relationOf(property);
  const wantTwin =
    isObject(next.twoWay) && typeof next.twoWay.propertyId === "string"
      ? next.twoWay.propertyId
      : null;
  if (next.dataSourceId !== old.dataSourceId)
    return yield* dbError("invalid_property_config", property.id);
  if (old.twinId !== null && wantTwin !== null && old.twinId !== wantTwin)
    return yield* dbError("invalid_property_config", property.id);
  const parentOfSubItems = snapshot.source.sub_items_property_id === property.id;
  const childOfSubItems =
    snapshot.source.sub_items_property_id !== null &&
    RelationStore.relationOf(snapshot.byId.get(snapshot.source.sub_items_property_id)!).twinId ===
      property.id;
  if (
    (parentOfSubItems && (next.limit !== "one" || wantTwin === null)) ||
    (childOfSubItems && wantTwin === null)
  )
    return yield* dbError("invalid_property_config", property.id);
  if (next.limit === "one" && old.limit === "many") {
    const wide = yield* sql`SELECT 1 FROM spaces_db_cells WHERE data_source_id = ${ctx.dataSourceId}
      AND property_id = ${property.id} GROUP BY page_id HAVING COUNT(*) > 1 LIMIT 1`;
    if (wide.length > 0) return yield* dbError("relation_limit", property.id);
  }
  const twin = yield* RelationStore.loadTwin(property, ctx.dataSourceId);
  if (old.twinId !== null && wantTwin === null && twin)
    yield* RelationStore.removeTwin({
      snapshot: twin.snapshot,
      twin: twin.twin,
      now: ctx.now,
      touched: ctx.touched,
    });
  yield* SchemaStore.setConfig(ctx.dataSourceId, property.id, next);
  if (old.twinId === null && wantTwin !== null) {
    const fresh = yield* reload(ctx);
    yield* RelationStore.createTwin({
      source: fresh,
      property: fresh.byId.get(property.id)!,
      twinId: wantTwin,
      now: ctx.now,
      touched: ctx.touched,
    });
  }
});

const updateProperty = Effect.fn("SpacesDatabases.updateProperty")(function* (
  ctx: Context,
  op: Extract<C.SpaceSchemaOperation, { readonly op: "updateProperty" }>,
) {
  const snapshot = yield* reload(ctx);
  const property = yield* SchemaStore.liveProperty(snapshot, op.propertyId);
  if (op.name !== undefined) {
    const name = yield* DatabaseStore.validName(op.name);
    yield* SchemaStore.nameFree(snapshot, name, property.id);
    yield* SchemaStore.setProperty(ctx.dataSourceId, property.id, { name });
  }
  if (op.description !== undefined)
    yield* SchemaStore.setProperty(ctx.dataSourceId, property.id, { description: op.description });
  if (op.config === undefined) return;
  if (isObject(op.config) && "options" in op.config)
    return yield* dbError("invalid_property_config", property.id);
  if (property.type === "relation")
    return yield* updateRelation(ctx, snapshot, property, op.config);
  const config = yield* normalizeConfig(property.type, op.config, property.id);
  if (property.type === "status")
    yield* stripStatusDefault(
      config,
      property.options.map((o) => o.option_id),
      property.id,
    );
  yield* SchemaStore.setConfig(ctx.dataSourceId, property.id, config);
  if (property.type === "formula" || property.type === "rollup")
    yield* Definitions.define(ctx, property.id);
});

const purgeOverflow = Effect.fn("SpacesDatabases.purgeOverflow")(function* (ctx: Context) {
  const snapshot = yield* reload(ctx);
  const deleted = snapshot.all.filter((p) => p.deletedAtMs !== null);
  if (deleted.length <= databaseLimits.maxDeletedPropertiesPerDataSource) return;
  const oldest = [...deleted].sort(
    (a, b) => a.deletedAtMs! - b.deletedAtMs! || a.position - b.position,
  )[0]!;
  yield* SchemaStore.purgeProperty(ctx.dataSourceId, oldest.id);
});

const removeProperty = Effect.fn("SpacesDatabases.removeProperty")(function* (
  ctx: Context,
  propertyId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const snapshot = yield* reload(ctx);
  const property = yield* SchemaStore.liveProperty(snapshot, propertyId);
  if (property.type === "title") return yield* dbError("title_property", property.id);
  const twin =
    property.type === "relation"
      ? yield* RelationStore.loadTwin(property, ctx.dataSourceId)
      : undefined;
  yield* SchemaStore.setDeleted(ctx.dataSourceId, property.id, ctx.now);
  yield* ViewStore.strip(
    ctx.dataSourceId,
    { propertyId: property.id, column: true, filters: true, sorts: true, groups: true },
    iso(ctx),
  );
  yield* sql`UPDATE spaces_db_data_sources SET sub_items_property_id = NULL
    WHERE data_source_id = ${ctx.dataSourceId} AND sub_items_property_id = ${property.id}`;
  if (twin)
    yield* RelationStore.removeTwin({
      snapshot: twin.snapshot,
      twin: twin.twin,
      now: ctx.now,
      touched: ctx.touched,
    });
  yield* purgeOverflow(ctx);
});

const restoreName = (snapshot: Snapshot, property: Property) => {
  const taken = new Set(snapshot.live.map((p) => fold(p.name)));
  if (!taken.has(fold(property.name))) return property.name;
  for (let n = 1; ; n++) {
    const candidate = `${property.name} (${n})`;
    if (!taken.has(fold(candidate))) return candidate;
  }
};

const restoreIn = Effect.fn("SpacesDatabases.restoreIn")(function* (
  snapshot: Snapshot,
  property: Property,
) {
  const sourceId = snapshot.source.data_source_id;
  yield* ensureDatabaseLimit("maxPropertiesPerDataSource", snapshot.live.length + 1);
  if (property.type === "unique_id" && snapshot.live.some((p) => p.type === "unique_id"))
    return yield* dbError("invalid_property_config", property.id);
  const name = restoreName(snapshot, property);
  if (name !== property.name) yield* SchemaStore.setProperty(sourceId, property.id, { name });
  yield* SchemaStore.setDeleted(sourceId, property.id, null);
});

const restoreProperty = Effect.fn("SpacesDatabases.restoreProperty")(function* (
  ctx: Context,
  propertyId: string,
) {
  const snapshot = yield* reload(ctx);
  const property = snapshot.byId.get(propertyId);
  if (!property) return yield* notFound("property", propertyId);
  if (property.deletedAtMs === null) return;
  yield* restoreIn(snapshot, property);
  if (property.type !== "relation") return;
  const { dataSourceId, twinId } = RelationStore.relationOf(property);
  if (twinId === null) return;
  const sql = yield* SpacesSql.SpacesSql;
  const [exists] =
    yield* sql`SELECT 1 FROM spaces_db_data_sources WHERE data_source_id = ${dataSourceId}`;
  const other = !exists
    ? undefined
    : dataSourceId === ctx.dataSourceId
      ? yield* reload(ctx)
      : yield* SchemaStore.load(dataSourceId);
  const twin = other?.byId.get(twinId);
  const back = twin?.type === "relation" ? RelationStore.relationOf(twin) : undefined;
  // A pair mirrors only while both sides name each other; a stale half comes back one-way.
  if (!other || !twin || back?.twinId !== property.id || back.dataSourceId !== ctx.dataSourceId) {
    const { twoWay: _stale, ...oneWay } = property.config;
    yield* SchemaStore.setConfig(ctx.dataSourceId, property.id, oneWay);
    return;
  }
  if (twin.deletedAtMs === null) return;
  yield* restoreIn(other, twin);
  yield* DatabaseStore.bumpSchema(dataSourceId, iso(ctx));
  ctx.touched.schema.add(dataSourceId);
});

const optionProperty = Effect.fn("SpacesDatabases.optionProperty")(function* (
  snapshot: Snapshot,
  propertyId: string,
) {
  const property = yield* SchemaStore.liveProperty(snapshot, propertyId);
  if (!optionTypes.has(property.type))
    return yield* dbError("invalid_property_config", property.id);
  return property;
});

const findOption = Effect.fn("SpacesDatabases.findOption")(function* (
  property: Property,
  id: string,
) {
  const option = property.options.find((o) => o.option_id === id);
  return option ?? (yield* notFound("option", id));
});

const removeOption = Effect.fn("SpacesDatabases.removeOption")(function* (
  ctx: Context,
  op: Extract<C.SpaceSchemaOperation, { readonly op: "removeOption" }>,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const snapshot = yield* reload(ctx);
  const property = yield* optionProperty(snapshot, op.propertyId);
  yield* findOption(property, op.optionId);
  if (property.type === "status" && property.options.length <= 1)
    return yield* dbError("last_option", property.id);
  const [cleared] = yield* sql<{
    readonly count: number;
  }>`SELECT COUNT(DISTINCT page_id) AS count FROM spaces_db_cells
    WHERE data_source_id = ${ctx.dataSourceId} AND property_id = ${property.id} AND ref = ${op.optionId}`;
  yield* sql`DELETE FROM spaces_db_cells WHERE data_source_id = ${ctx.dataSourceId}
    AND property_id = ${property.id} AND ref = ${op.optionId}`;
  yield* sql`DELETE FROM spaces_db_options WHERE data_source_id = ${ctx.dataSourceId}
    AND property_id = ${property.id} AND option_id = ${op.optionId}`;
  if (property.config.defaultOptionId === op.optionId) {
    const { defaultOptionId: _removed, ...rest } = property.config;
    yield* SchemaStore.setConfig(ctx.dataSourceId, property.id, rest);
  }
  yield* ViewStore.strip(
    ctx.dataSourceId,
    {
      propertyId: property.id,
      optionId: op.optionId,
      column: false,
      filters: false,
      sorts: false,
      groups: false,
    },
    iso(ctx),
  );
  if ((cleared?.count ?? 0) > 0) ctx.touched.sources.add(ctx.dataSourceId);
  return cleared?.count ?? 0;
});

const updateOption = Effect.fn("SpacesDatabases.updateOption")(function* (
  ctx: Context,
  op: Extract<C.SpaceSchemaOperation, { readonly op: "updateOption" }>,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const snapshot = yield* reload(ctx);
  const property = yield* optionProperty(snapshot, op.propertyId);
  yield* findOption(property, op.optionId);
  if (op.group !== undefined && property.type !== "status")
    return yield* dbError("invalid_property_config", property.id);
  if (op.name !== undefined) {
    const name = yield* DatabaseStore.validName(op.name);
    if (property.options.some((o) => o.option_id !== op.optionId && o.name_key === fold(name)))
      return yield* dbError("duplicate_name", property.id);
    yield* sql`UPDATE spaces_db_options SET name = ${name}, name_key = ${fold(name)} WHERE data_source_id = ${ctx.dataSourceId}
      AND property_id = ${property.id} AND option_id = ${op.optionId}`;
  }
  if (op.color !== undefined)
    yield* sql`UPDATE spaces_db_options SET color = ${op.color} WHERE data_source_id = ${ctx.dataSourceId}
      AND property_id = ${property.id} AND option_id = ${op.optionId}`;
  if (op.group !== undefined)
    yield* sql`UPDATE spaces_db_options SET status_group = ${op.group} WHERE data_source_id = ${ctx.dataSourceId}
      AND property_id = ${property.id} AND option_id = ${op.optionId}`;
});

const changeType = Effect.fn("SpacesDatabases.changePropertyType")(function* (
  ctx: Context,
  op: Extract<C.SpaceSchemaOperation, { readonly op: "changePropertyType" }>,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const snapshot = yield* reload(ctx);
  const from = yield* SchemaStore.liveProperty(snapshot, op.propertyId);
  const to = op.type;
  if (from.type === "title" || to === "title") return yield* dbError("title_property", from.id);
  if (from.type === to) {
    if (op.config !== undefined)
      yield* updateProperty(ctx, {
        op: "updateProperty",
        propertyId: op.propertyId,
        config: op.config,
      });
    return 0;
  }
  if (to === "unique_id" && snapshot.live.some((p) => p.type === "unique_id"))
    return yield* dbError("invalid_property_config", from.id);
  const config = yield* normalizeConfig(to, op.config, from.id);
  if (to === "relation")
    yield* RelationStore.checkTarget(snapshot, String(config.dataSourceId), from.id);
  const oldTwin =
    from.type === "relation" ? yield* RelationStore.loadTwin(from, ctx.dataSourceId) : undefined;
  if (oldTwin)
    yield* RelationStore.removeTwin({
      snapshot: oldTwin.snapshot,
      twin: oldTwin.twin,
      now: ctx.now,
      touched: ctx.touched,
    });
  if (snapshot.source.sub_items_property_id === from.id)
    yield* sql`UPDATE spaces_db_data_sources SET sub_items_property_id = NULL WHERE data_source_id = ${ctx.dataSourceId}`;
  // Options: carried between select kinds, created for a fresh status, dropped when leaving the family.
  const toOptions = optionTypes.has(to);
  let options: readonly OptionRecord[] =
    optionTypes.has(from.type) && toOptions ? [...from.options] : [];
  if (optionTypes.has(from.type) && !toOptions)
    yield* sql`DELETE FROM spaces_db_options WHERE data_source_id = ${ctx.dataSourceId} AND property_id = ${from.id}`;
  if (toOptions && optionTypes.has(from.type))
    yield* sql`UPDATE spaces_db_options SET status_group = ${to === "status" ? "todo" : null}
      WHERE data_source_id = ${ctx.dataSourceId} AND property_id = ${from.id}`;
  let storedConfig: JsonObject = config;
  if (to === "status" && options.length === 0) {
    const fresh: Property = { ...from, type: "status", options: [] };
    let first: string | undefined;
    for (const draft of SchemaStore.defaultStatusOptions) {
      const id = yield* SchemaStore.addOption(ctx.dataSourceId, { ...fresh, options }, draft);
      first ??= id;
      options =
        yield* sql<OptionRecord>`SELECT * FROM spaces_db_options WHERE data_source_id = ${ctx.dataSourceId}
        AND property_id = ${from.id} ORDER BY position, option_id`;
    }
    storedConfig = { defaultOptionId: first! };
  } else if (to === "status") {
    if (typeof config.defaultOptionId === "string")
      yield* stripStatusDefault(
        config,
        options.map((o) => o.option_id),
        from.id,
      );
  } else if (toOptions) storedConfig = {};
  const createOption = Effect.fn("SpacesDatabases.createOption")(function* (name: string) {
    if (options.length >= databaseLimits.maxOptionsPerProperty) return undefined;
    const id = yield* SchemaStore.addOption(
      ctx.dataSourceId,
      { ...from, type: to, options },
      { name },
    );
    options =
      yield* sql<OptionRecord>`SELECT * FROM spaces_db_options WHERE data_source_id = ${ctx.dataSourceId}
      AND property_id = ${from.id} ORDER BY position, option_id`;
    return id;
  });
  let cleared = 0;
  let after = "";
  for (;;) {
    const pages = yield* sql<{
      readonly page_id: string;
    }>`SELECT DISTINCT page_id FROM spaces_db_cells WHERE data_source_id = ${ctx.dataSourceId}
      AND property_id = ${from.id} AND page_id > ${after} ORDER BY page_id LIMIT 1000`;
    if (pages.length === 0) break;
    const cells = yield* CellStore.readCells(
      pages.map((p) => p.page_id),
      [from.id],
    );
    for (const { page_id } of pages) {
      const rows = cells.get(page_id)?.get(from.id) ?? [];
      const result = yield* Conversion.convertCell({ from, to, options, createOption }, rows);
      yield* sql`DELETE FROM spaces_db_cells WHERE page_id = ${page_id} AND property_id = ${from.id}`;
      if (result === "clear") cleared++;
      else
        for (const [ord, item] of result.entries())
          yield* sql`INSERT INTO spaces_db_cells (page_id, property_id, ord, data_source_id, ref, text_key, text_full, num, time_start, time_end, flags, value)
            VALUES (${page_id}, ${from.id}, ${ord}, ${ctx.dataSourceId}, ${item.ref}, ${item.text_key}, ${item.text_full},
            ${item.num}, ${item.time_start}, ${item.time_end}, ${item.flags}, ${item.value})`;
    }
    after = pages[pages.length - 1]!.page_id;
  }
  yield* SchemaStore.setType(ctx.dataSourceId, from.id, to, storedConfig);
  if (from.type === "formula" || from.type === "rollup")
    yield* Definitions.remove(ctx.dataSourceId, from.id);
  if (to === "formula" || to === "rollup") yield* Definitions.define(ctx, from.id);
  yield* ViewStore.strip(
    ctx.dataSourceId,
    { propertyId: from.id, column: false, filters: true, sorts: true, groups: true },
    iso(ctx),
  );
  if (to === "relation") {
    const twinId = RelationStore.relationOf({ ...from, type: "relation", config }).twinId;
    if (twinId !== null) {
      const fresh = yield* reload(ctx);
      yield* RelationStore.createTwin({
        source: fresh,
        property: fresh.byId.get(from.id)!,
        twinId,
        now: ctx.now,
        touched: ctx.touched,
      });
    }
  }
  ctx.touched.sources.add(ctx.dataSourceId);
  return cleared;
});

interface SchemaResult {
  readonly created: { index: number; propertyId?: C.SpacePropertyId; optionId?: C.SpaceOptionId }[];
  readonly clearedCells: number;
}

export const applyOperations = Effect.fn("SpacesDatabases.applyOperations")(function* (
  ctx: Context,
  operations: readonly C.SpaceSchemaOperation[],
) {
  yield* ensureDatabaseLimit("maxSchemaOperations", operations.length);
  const created: SchemaResult["created"] = [];
  let clearedCells = 0;
  // Properties whose values or meaning changed in place, and restored ones, for computed readers.
  const changed = new Set<string>();
  const restored = new Set<string>();
  const reshapes = operations.some(
    (op) =>
      op.op !== "moveProperty" &&
      op.op !== "moveOption" &&
      op.op !== "addOption" &&
      !(op.op === "updateProperty" && op.name === undefined && op.config === undefined),
  );
  for (const [index, op] of operations.entries()) {
    if (
      op.op === "changePropertyType" ||
      op.op === "removeProperty" ||
      op.op === "restoreProperty" ||
      op.op === "updateOption" ||
      op.op === "removeOption" ||
      (op.op === "updateProperty" && op.config !== undefined)
    )
      changed.add(op.propertyId);
    if (op.op === "restoreProperty") restored.add(op.propertyId);
    switch (op.op) {
      case "addProperty": {
        const id = yield* addProperty(ctx, op.property, op.beforePropertyId ?? null);
        created.push({ index, propertyId: C.SpacePropertyId.make(id) });
        break;
      }
      case "updateProperty":
        yield* updateProperty(ctx, op);
        break;
      case "changePropertyType":
        clearedCells += yield* changeType(ctx, op);
        break;
      case "moveProperty": {
        const snapshot = yield* reload(ctx);
        yield* SchemaStore.liveProperty(snapshot, op.propertyId);
        if (op.beforePropertyId !== null)
          yield* SchemaStore.liveProperty(snapshot, op.beforePropertyId);
        yield* SchemaStore.movePositions(snapshot, op.propertyId, op.beforePropertyId);
        break;
      }
      case "removeProperty":
        yield* removeProperty(ctx, op.propertyId);
        break;
      case "restoreProperty":
        yield* restoreProperty(ctx, op.propertyId);
        break;
      case "addOption": {
        const snapshot = yield* reload(ctx);
        const property = yield* optionProperty(snapshot, op.propertyId);
        const id = yield* SchemaStore.addOption(
          ctx.dataSourceId,
          property,
          op.option,
          op.beforeOptionId ?? null,
        );
        created.push({ index, optionId: C.SpaceOptionId.make(id) });
        break;
      }
      case "updateOption":
        yield* updateOption(ctx, op);
        break;
      case "moveOption": {
        const snapshot = yield* reload(ctx);
        const property = yield* optionProperty(snapshot, op.propertyId);
        yield* findOption(property, op.optionId);
        if (op.beforeOptionId !== null) yield* findOption(property, op.beforeOptionId);
        yield* SchemaStore.moveOption(ctx.dataSourceId, property, op.optionId, op.beforeOptionId);
        break;
      }
      case "removeOption":
        clearedCells += yield* removeOption(ctx, op);
        break;
    }
  }
  yield* DatabaseStore.bumpSchema(ctx.dataSourceId, iso(ctx));
  ctx.touched.schema.add(ctx.dataSourceId);
  if (reshapes) yield* Definitions.afterSchema(ctx, changed, restored);
  for (const id of ctx.touched.schema) yield* SchemaStore.checkSchemaBytes(id);
  return { created, clearedCells } satisfies SchemaResult;
});
