import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { byteLength, canonical, ensureDatabaseLimit } from "../CorePolicy.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as DatabaseStore from "./DatabaseStore.ts";
import { fold } from "./Fold.ts";
import * as Ids from "./Ids.ts";
import { type Json, type JsonObject, isObject, parseJson } from "./Json.ts";
import { optionTypes } from "./PropertyConfig.ts";
import { placeInList } from "./Position.ts";
import {
  type DataSourceRecord,
  type OptionRecord,
  type PropertyRecord,
  dbError,
  isoNow,
  notFound,
} from "./Types.ts";

const isType = Schema.is(C.SpacePropertyType);

export interface Property {
  readonly id: string;
  readonly name: string;
  readonly type: C.SpacePropertyType;
  /** Stored config: never contains options. */
  readonly config: JsonObject;
  readonly description: string | null;
  readonly position: number;
  readonly deletedAtMs: number | null;
  readonly options: readonly OptionRecord[];
}
export interface Snapshot {
  readonly source: DataSourceRecord;
  /** Every property, live and soft-deleted, in position order. */
  readonly all: readonly Property[];
  readonly byId: ReadonlyMap<string, Property>;
  readonly live: readonly Property[];
}

export const load = Effect.fn("SpacesDatabases.loadSchema")(function* (dataSourceId: string) {
  const sql = yield* SpacesSql.SpacesSql;
  const source = yield* DatabaseStore.getDataSource(dataSourceId);
  const records = yield* sql<PropertyRecord>`SELECT * FROM spaces_db_properties
    WHERE data_source_id = ${dataSourceId} ORDER BY position, property_id`;
  const options = yield* sql<OptionRecord>`SELECT * FROM spaces_db_options
    WHERE data_source_id = ${dataSourceId} ORDER BY property_id, position, option_id`;
  const all: Property[] = [];
  for (const record of records) {
    if (!isType(record.type)) return yield* new C.SpacesUnavailableError({ stage: "storage" });
    const config = parseJson(record.config);
    all.push({
      id: record.property_id,
      name: record.name,
      type: record.type,
      config: isObject(config) ? config : {},
      description: record.description,
      position: record.position,
      deletedAtMs: record.deleted_at_ms,
      options: options.filter((option) => option.property_id === record.property_id),
    });
  }
  return {
    source,
    all,
    byId: new Map(all.map((property) => [property.id, property])),
    live: all.filter((property) => property.deletedAtMs === null),
  } satisfies Snapshot;
});

export const liveProperty = (snapshot: Snapshot, id: string) => {
  const property = snapshot.byId.get(id);
  return property && property.deletedAtMs === null
    ? Effect.succeed(property)
    : Effect.fail(notFound("property", id));
};

const optionsWire = (property: Property) =>
  property.options.map((option) => ({
    id: C.SpaceOptionId.make(option.option_id),
    name: option.name,
    color: option.color,
    ...(property.type === "status" && option.status_group ? { group: option.status_group } : {}),
  }));

const wireProperty = (property: Property): C.SpaceDatabaseProperty => {
  const config: Json = optionTypes.has(property.type)
    ? { ...property.config, options: optionsWire(property) }
    : property.config;
  return {
    id: C.SpacePropertyId.make(property.id),
    name: property.name,
    type: property.type,
    config,
    position: property.position,
    ...(property.description === null ? {} : { description: property.description }),
  };
};

export const wireProperties = (snapshot: Snapshot) =>
  Object.fromEntries(snapshot.live.map((property) => [property.id, wireProperty(property)]));

export const wireDeleted = (snapshot: Snapshot) =>
  snapshot.all
    .filter((property) => property.deletedAtMs !== null)
    .map((property) => ({
      id: C.SpacePropertyId.make(property.id),
      name: property.name,
      type: property.type,
      deletedAt: isoNow(property.deletedAtMs!),
    }));

export const checkSchemaBytes = Effect.fn("SpacesDatabases.checkSchemaBytes")(function* (
  dataSourceId: string,
) {
  const snapshot = yield* load(dataSourceId);
  yield* ensureDatabaseLimit("maxSchemaBytes", byteLength(wireProperties(snapshot)));
});

export const relationConfig = (property: Property) => {
  const { dataSourceId, limit, twoWay } = property.config;
  return {
    dataSourceId: typeof dataSourceId === "string" ? dataSourceId : "",
    limit: limit === "one" ? ("one" as const) : ("many" as const),
    twinId: isObject(twoWay) && typeof twoWay.propertyId === "string" ? twoWay.propertyId : null,
  };
};

export const nameFree = Effect.fn("SpacesDatabases.nameFree")(function* (
  snapshot: Snapshot,
  name: string,
  exceptId?: string,
) {
  const key = fold(name);
  if (snapshot.live.some((property) => property.id !== exceptId && fold(property.name) === key))
    return yield* dbError("duplicate_name", exceptId);
});

export const insertProperty = Effect.fn("SpacesDatabases.insertProperty")(function* (input: {
  readonly dataSourceId: string;
  readonly id: string;
  readonly name: string;
  readonly type: C.SpacePropertyType;
  readonly config: JsonObject;
  readonly description?: string | undefined;
  readonly position: number;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`INSERT INTO spaces_db_properties (data_source_id, property_id, name, name_key, type, config, description, position)
    VALUES (${input.dataSourceId}, ${input.id}, ${input.name}, ${fold(input.name)}, ${input.type},
    ${canonical(input.config)}, ${input.description ?? null}, ${input.position})`;
});

export const setConfig = Effect.fn("SpacesDatabases.setConfig")(function* (
  dataSourceId: string,
  propertyId: string,
  config: JsonObject,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_db_properties SET config = ${canonical(config)}
    WHERE data_source_id = ${dataSourceId} AND property_id = ${propertyId}`;
});

export const setProperty = Effect.fn("SpacesDatabases.setProperty")(function* (
  dataSourceId: string,
  propertyId: string,
  patch: { readonly name?: string; readonly description?: string | null },
) {
  const sql = yield* SpacesSql.SpacesSql;
  if (patch.name !== undefined)
    yield* sql`UPDATE spaces_db_properties SET name = ${patch.name}, name_key = ${fold(patch.name)}
      WHERE data_source_id = ${dataSourceId} AND property_id = ${propertyId}`;
  if (patch.description !== undefined)
    yield* sql`UPDATE spaces_db_properties SET description = ${patch.description}
      WHERE data_source_id = ${dataSourceId} AND property_id = ${propertyId}`;
});

export const setDeleted = Effect.fn("SpacesDatabases.setDeleted")(function* (
  dataSourceId: string,
  propertyId: string,
  at: number | null,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_db_properties SET deleted_at_ms = ${at}
    WHERE data_source_id = ${dataSourceId} AND property_id = ${propertyId}`;
});

export const setType = Effect.fn("SpacesDatabases.setType")(function* (
  dataSourceId: string,
  propertyId: string,
  type: C.SpacePropertyType,
  config: JsonObject,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_db_properties SET type = ${type}, config = ${canonical(config)}
    WHERE data_source_id = ${dataSourceId} AND property_id = ${propertyId}`;
});

/** Hard delete of a property: options cascade, cells are removed explicitly. */
export const purgeProperty = Effect.fn("SpacesDatabases.purgeProperty")(function* (
  dataSourceId: string,
  propertyId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`DELETE FROM spaces_db_cells WHERE data_source_id = ${dataSourceId} AND property_id = ${propertyId}`;
  yield* sql`DELETE FROM spaces_db_properties WHERE data_source_id = ${dataSourceId} AND property_id = ${propertyId}`;
});

export const movePositions = Effect.fn("SpacesDatabases.moveProperty")(function* (
  snapshot: Snapshot,
  moving: string,
  beforeId: string | null,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const placed = placeInList(
    snapshot.live.map((property) => ({ id: property.id, position: property.position })),
    [moving],
    beforeId,
  );
  if (!placed) return yield* notFound("property", beforeId ?? moving);
  for (const [id, position] of placed)
    yield* sql`UPDATE spaces_db_properties SET position = ${position}
      WHERE data_source_id = ${snapshot.source.data_source_id} AND property_id = ${id}`;
});

export const endPosition = (snapshot: Snapshot) => {
  const last = snapshot.all[snapshot.all.length - 1];
  return last === undefined ? 65_536 : last.position + 65_536;
};

const checkOptionDraft = Effect.fn("SpacesDatabases.checkOptionDraft")(function* (
  type: C.SpacePropertyType,
  draft: C.SpaceOptionDraft,
  existing: readonly OptionRecord[],
  propertyId: string,
) {
  const name = draft.name.trim();
  if (name.length === 0) return yield* dbError("invalid_property_config", propertyId);
  yield* ensureDatabaseLimit("maxNameBytes", Buffer.byteLength(name, "utf8"));
  yield* ensureDatabaseLimit("maxOptionsPerProperty", existing.length + 1);
  if (type !== "status" && draft.group !== undefined)
    return yield* dbError("invalid_property_config", propertyId);
  if (existing.some((option) => option.name_key === fold(name)))
    return yield* dbError("duplicate_name", propertyId);
  if (draft.id !== undefined) {
    if (!Ids.clientIdPattern.test(draft.id) || existing.some((o) => o.option_id === draft.id))
      return yield* dbError("invalid_property_config", propertyId);
  }
  return name;
});

const insertOption = Effect.fn("SpacesDatabases.insertOption")(function* (input: {
  readonly dataSourceId: string;
  readonly propertyId: string;
  readonly id: string;
  readonly name: string;
  readonly color: C.SpaceDatabaseColor;
  readonly group: C.SpaceStatusGroup | null;
  readonly position: number;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`INSERT INTO spaces_db_options (data_source_id, property_id, option_id, name, name_key, color, status_group, position)
    VALUES (${input.dataSourceId}, ${input.propertyId}, ${input.id}, ${input.name}, ${fold(input.name)},
    ${input.color}, ${input.group}, ${input.position})`;
});

/** Adds an option at the end (or before `beforeId`) and returns its id. */
export const addOption = Effect.fn("SpacesDatabases.addOption")(function* (
  dataSourceId: string,
  property: Property,
  draft: C.SpaceOptionDraft,
  beforeId: string | null = null,
) {
  const name = yield* checkOptionDraft(property.type, draft, property.options, property.id);
  const id = draft.id ?? Ids.shortId(new Set(property.options.map((o) => o.option_id)));
  const last = property.options[property.options.length - 1];
  yield* insertOption({
    dataSourceId,
    propertyId: property.id,
    id,
    name,
    color: draft.color ?? "default",
    group: property.type === "status" ? (draft.group ?? "todo") : null,
    position: (last?.position ?? 0) + 65_536,
  });
  if (beforeId !== null) yield* moveOption(dataSourceId, property, id, beforeId, true);
  return id;
});

export const moveOption = Effect.fn("SpacesDatabases.moveOption")(function* (
  dataSourceId: string,
  property: Property,
  optionId: string,
  beforeId: string | null,
  includeNew = false,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const rows = includeNew
    ? yield* sql<OptionRecord>`SELECT * FROM spaces_db_options WHERE data_source_id = ${dataSourceId}
        AND property_id = ${property.id} ORDER BY position, option_id`
    : property.options;
  const placed = placeInList(
    rows.map((option) => ({ id: option.option_id, position: option.position })),
    [optionId],
    beforeId,
  );
  if (!placed) return yield* notFound("option", beforeId ?? optionId);
  for (const [id, position] of placed)
    yield* sql`UPDATE spaces_db_options SET position = ${position} WHERE data_source_id = ${dataSourceId}
      AND property_id = ${property.id} AND option_id = ${id}`;
});

export const defaultStatusOptions = [
  { name: "Not started", group: "todo", color: "default" },
  { name: "In progress", group: "in_progress", color: "blue" },
  { name: "Done", group: "complete", color: "green" },
] as const satisfies readonly C.SpaceOptionDraft[];
