import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as SpacesSql from "../SpacesSql.ts";
import { parseJson } from "./Json.ts";
import * as Liveness from "./Liveness.ts";
import * as SchemaStore from "./SchemaStore.ts";
import type { Snapshot } from "./SchemaStore.ts";
import type { DatabaseRecord } from "./Types.ts";

const decodeHomeBlock = Schema.decodeUnknownOption(C.SpaceDatabaseBlock, {
  onExcessProperty: "error",
});

export const wireDatabase = Effect.fn("SpacesDatabases.wireDatabase")(function* (
  record: DatabaseRecord,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const [home] =
    record.home_block_id === null
      ? []
      : yield* sql<{
          readonly page_id: C.SpacePageId;
          readonly block_id: C.SpaceBlockId;
          readonly payload: string;
        }>`SELECT page_id, block_id, payload FROM spaces_blocks WHERE block_id = ${record.home_block_id} AND deleted = 0`;
  const live = home !== undefined && (yield* Liveness.pageLive(home.page_id));
  const homeBlock = home ? decodeHomeBlock(parseJson(home.payload)) : Option.none();
  return {
    id: record.database_id,
    spaceId: record.space_id,
    title: record.title,
    ...(record.icon ? { icon: record.icon } : {}),
    revision: record.revision,
    home: home
      ? {
          pageId: home.page_id,
          blockId: home.block_id,
          ...(Option.isSome(homeBlock) ? { viewIds: [...homeBlock.value.content.viewIds] } : {}),
        }
      : null,
    live,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  } satisfies C.SpaceDatabase;
});

export const wireDataSource = Effect.fn("SpacesDatabases.wireDataSource")(function* (
  snapshot: Snapshot,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const { source } = snapshot;
  const templates = yield* sql<{
    readonly page_id: C.SpacePageId;
    readonly title: string;
    readonly icon: string | null;
  }>`SELECT page_id, title, icon FROM spaces_pages WHERE data_source_id = ${source.data_source_id}
    AND row_template = 1 AND trash_batch_id IS NULL ORDER BY row_position, row_seq LIMIT 100`;
  const others = new Map<string, Snapshot>();
  for (const property of snapshot.live)
    for (const ref of property.computed?.refs ?? [])
      if (ref.dataSourceId !== source.data_source_id && !others.has(ref.dataSourceId)) {
        const loaded = yield* SchemaStore.load(ref.dataSourceId).pipe(Effect.option);
        if (loaded._tag === "Some") others.set(ref.dataSourceId, loaded.value);
      }
  const nameOf: SchemaStore.NameOf = (dataSourceId, propertyId) =>
    (dataSourceId === source.data_source_id ? snapshot : others.get(dataSourceId))?.byId.get(
      propertyId,
    )?.name;
  const parent =
    source.sub_items_property_id === null
      ? undefined
      : snapshot.byId.get(source.sub_items_property_id);
  const children =
    parent && parent.deletedAtMs === null ? SchemaStore.relationConfig(parent).twinId : null;
  return {
    id: source.data_source_id,
    databaseId: source.database_id,
    name: source.name,
    position: source.position,
    schemaRevision: source.schema_revision,
    dataRevision: source.data_revision,
    properties: SchemaStore.wireProperties(snapshot, nameOf),
    deletedProperties: SchemaStore.wireDeleted(snapshot),
    ...(parent && children !== null
      ? {
          subItems: {
            parentPropertyId: C.SpacePropertyId.make(parent.id),
            childrenPropertyId: C.SpacePropertyId.make(children),
          },
        }
      : {}),
    ...(source.default_template_id === null
      ? {}
      : { defaultTemplateId: C.SpacePageId.make(source.default_template_id) }),
    templates: templates.map((row) => ({
      pageId: row.page_id,
      title: row.title,
      ...(row.icon ? { icon: row.icon } : {}),
    })),
  } satisfies C.SpaceDataSource;
});
