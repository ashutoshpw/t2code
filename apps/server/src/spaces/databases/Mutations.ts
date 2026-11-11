// @effect-diagnostics nodeBuiltinImport:off -- block ids use the platform cryptographic generator.
import * as NodeCrypto from "node:crypto";

import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { byteLength } from "../CorePolicy.ts";
import { truncateBytes } from "./Fold.ts";
import type * as Receipts from "../Receipts.ts";
import * as PageStore from "../PageStore.ts";
import * as SpacesSql from "../SpacesSql.ts";
import { decodeReceipt, getSpace } from "../service/Helpers.ts";
import * as BlockEdits from "./BlockEdits.ts";
import * as DatabaseStore from "./DatabaseStore.ts";
import * as Ids from "./Ids.ts";
import * as Liveness from "./Liveness.ts";
import { rowsMutation } from "./MutationsRows.ts";
import * as RelationStore from "./RelationStore.ts";
import * as SchemaOps from "./SchemaOps.ts";
import * as SchemaStore from "./SchemaStore.ts";
import * as Touched from "./Touched.ts";
import { dbError, isoNow, notFound } from "./Types.ts";
import * as ViewStore from "./ViewStore.ts";

type Operation =
  | "createDatabase"
  | "updateDatabase"
  | "createDataSource"
  | "updateDataSource"
  | "deleteDataSource"
  | "updateSchema"
  | "createView"
  | "updateView"
  | "deleteView"
  | "createRows"
  | "updateRows"
  | "moveRows";
type DatabaseRequest = Extract<C.SpaceMutationRequest, { readonly operation: Operation }>;

const saveable = { status: "saved" as const };

/** The title property every data source starts with. */
const insertTitleProperty = Effect.fn("SpacesDatabases.insertTitleProperty")(function* (
  dataSourceId: string,
) {
  yield* SchemaStore.insertProperty({
    dataSourceId,
    id: C.SPACE_TITLE_PROPERTY_ID,
    name: "Name",
    type: "title",
    config: {},
    position: 65_536,
  });
});

const addDrafts = Effect.fn("SpacesDatabases.addDrafts")(function* (
  ctx: SchemaOps.Context,
  drafts: readonly C.SpacePropertyDraft[] | undefined,
) {
  const ids: C.SpacePropertyId[] = [];
  for (const draft of drafts ?? [])
    ids.push(C.SpacePropertyId.make(yield* SchemaOps.addProperty(ctx, draft)));
  return ids;
});

const finishDatabaseWork = Effect.fn("SpacesDatabases.finishDatabaseWork")(function* (
  touched: Touched.Touched,
  now: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  for (const id of touched.sources)
    yield* sql`UPDATE spaces_db_data_sources SET data_revision = data_revision + 1, updated_at = ${isoNow(now)} WHERE data_source_id = ${id}`;
});

export const execute = Effect.fn("SpacesDatabases.execute")(function* (
  request: DatabaseRequest,
  meta: Receipts.Metadata,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const now = meta.observed_time_ms;
  const iso = isoNow(now);
  const ack = { mutationId: request.input.mutationId, receiptEpoch: request.input.receiptEpoch };
  const requestBytes = byteLength(request);
  switch (request.operation) {
    case "createDatabase": {
      const input = request.input;
      yield* getSpace(input.spaceId);
      let page: PageStore.PageRow | undefined;
      if (input.appendToPageId !== undefined) {
        page = yield* PageStore.read(input.appendToPageId);
        yield* PageStore.assertActive(page);
        yield* Liveness.assertPageLive(page.page_id);
        if (page.space_id !== input.spaceId)
          return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
      }
      const databaseId = yield* DatabaseStore.insertDatabase({
        spaceId: input.spaceId,
        title: input.title,
        icon: input.icon ?? null,
        now: iso,
      });
      const dataSourceId = yield* DatabaseStore.insertDataSource({
        databaseId,
        name: truncateBytes(input.title.trim(), 256) || "Untitled",
        now: iso,
      });
      yield* insertTitleProperty(dataSourceId);
      yield* sql`UPDATE spaces_core SET catalog_revision = catalog_revision + 1 WHERE singleton = 1`;
      const touched = Touched.touched();
      const propertyIds = yield* addDrafts({ dataSourceId, now, touched }, input.properties);
      const snapshot = yield* SchemaStore.load(dataSourceId);
      const blockId = C.SpaceBlockId.make(NodeCrypto.randomUUID());
      const viewId = yield* ViewStore.createView({
        snapshot,
        databaseId,
        definition: {
          name: "Table",
          type: "table",
          filter: null,
          sorts: [],
          group: null,
          subGroup: null,
          properties: [C.SPACE_TITLE_PROPERTY_ID, ...propertyIds].map((id) => ({
            propertyId: C.SpacePropertyId.make(id),
            visible: true,
          })),
          layout: {},
        },
        beforeViewId: null,
        ownerBlockId: page ? blockId : null,
        now: iso,
      });
      yield* SchemaStore.checkSchemaBytes(dataSourceId);
      yield* finishDatabaseWork(touched, now);
      const block = page
        ? yield* BlockEdits.appendBlock({
            pageId: page.page_id,
            blockId,
            databaseId,
            viewIds: [viewId],
            mutationId: input.mutationId,
            nowMs: now,
            requestBytes,
          })
        : undefined;
      return decodeReceipt({
        operation: request.operation,
        result: {
          ...saveable,
          ...ack,
          databaseId,
          dataSourceId,
          viewId,
          propertyIds,
          ...(block ? { block } : {}),
        },
      });
    }
    case "updateDatabase": {
      const input = request.input;
      const database = yield* DatabaseStore.getLiveDatabase(input.databaseId);
      const icon = input.icon === undefined ? database.icon : input.icon;
      const title = input.title ?? database.title;
      let revision = database.revision;
      if (title !== database.title || icon !== database.icon) {
        yield* sql`UPDATE spaces_db_databases SET title = ${title}, icon = ${icon} WHERE database_id = ${database.database_id}`;
        revision = yield* DatabaseStore.touchDatabase(database.database_id, iso);
      }
      return decodeReceipt({
        operation: request.operation,
        result: { ...saveable, ...ack, databaseId: input.databaseId, revision },
      });
    }
    case "createDataSource": {
      const input = request.input;
      const database = yield* DatabaseStore.getLiveDatabase(input.databaseId);
      const name = yield* DatabaseStore.validName(input.name);
      const dataSourceId = yield* DatabaseStore.insertDataSource({
        databaseId: database.database_id,
        name,
        now: iso,
      });
      yield* insertTitleProperty(dataSourceId);
      const touched = Touched.touched();
      const propertyIds = yield* addDrafts({ dataSourceId, now, touched }, input.properties);
      yield* SchemaStore.checkSchemaBytes(dataSourceId);
      yield* finishDatabaseWork(touched, now);
      const revision = yield* DatabaseStore.touchDatabase(database.database_id, iso);
      return decodeReceipt({
        operation: request.operation,
        result: { ...saveable, ...ack, dataSourceId, propertyIds, revision },
      });
    }
    case "updateDataSource": {
      const input = request.input;
      const source = yield* DatabaseStore.getLiveDataSource(input.dataSourceId);
      if (input.name !== undefined) {
        const name = yield* DatabaseStore.validName(input.name);
        yield* sql`UPDATE spaces_db_data_sources SET name = ${name} WHERE data_source_id = ${source.data_source_id}`;
      }
      if (input.subItems !== undefined) {
        if (input.subItems === null)
          yield* sql`UPDATE spaces_db_data_sources SET sub_items_property_id = NULL WHERE data_source_id = ${source.data_source_id}`;
        else {
          const snapshot = yield* SchemaStore.load(source.data_source_id);
          const parent = yield* SchemaStore.liveProperty(snapshot, input.subItems.parentPropertyId);
          yield* RelationStore.checkSubItemsParent(snapshot, parent);
          yield* sql`UPDATE spaces_db_data_sources SET sub_items_property_id = ${parent.id} WHERE data_source_id = ${source.data_source_id}`;
        }
      }
      if (input.defaultTemplateId !== undefined) {
        if (input.defaultTemplateId !== null) {
          const [template] =
            yield* sql`SELECT 1 FROM spaces_pages WHERE page_id = ${input.defaultTemplateId}
            AND data_source_id = ${source.data_source_id} AND row_template = 1 AND trash_batch_id IS NULL`;
          if (!template) return yield* dbError("not_a_row");
        }
        yield* sql`UPDATE spaces_db_data_sources SET default_template_id = ${input.defaultTemplateId} WHERE data_source_id = ${source.data_source_id}`;
      }
      yield* DatabaseStore.bumpSchema(source.data_source_id, iso);
      const revision = yield* DatabaseStore.touchDatabase(source.database_id, iso);
      const fresh = yield* DatabaseStore.getDataSource(source.data_source_id);
      return decodeReceipt({
        operation: request.operation,
        result: {
          ...saveable,
          ...ack,
          dataSourceId: source.data_source_id,
          schemaRevision: fresh.schema_revision,
          revision,
        },
      });
    }
    case "deleteDataSource": {
      const input = request.input;
      const source = yield* DatabaseStore.getLiveDataSource(input.dataSourceId);
      if (source.row_count > 0) return yield* dbError("data_source_not_empty");
      const siblings = yield* DatabaseStore.sourcesOf(source.database_id);
      if (siblings.length <= 1) return yield* dbError("last_data_source");
      const snapshot = yield* SchemaStore.load(source.data_source_id);
      const touched = Touched.touched();
      for (const property of snapshot.live) {
        if (property.type !== "relation") continue;
        const twin = yield* RelationStore.loadTwin(property, source.data_source_id);
        if (twin && twin.snapshot.source.data_source_id !== source.data_source_id)
          yield* RelationStore.removeTwin({
            snapshot: twin.snapshot,
            twin: twin.twin,
            now,
            touched,
          });
      }
      for (const view of yield* ViewStore.viewsOfSource(source.data_source_id)) {
        yield* sql`DELETE FROM spaces_db_views WHERE view_id = ${view.view_id}`;
        yield* Ids.retire(view.view_id);
      }
      yield* sql`DELETE FROM spaces_db_data_sources WHERE data_source_id = ${source.data_source_id}`;
      yield* Ids.retire(source.data_source_id);
      const revision = yield* DatabaseStore.touchDatabase(source.database_id, iso);
      return decodeReceipt({
        operation: request.operation,
        result: { ...saveable, ...ack, dataSourceId: input.dataSourceId, revision },
      });
    }
    case "updateSchema": {
      const input = request.input;
      const source = yield* DatabaseStore.getLiveDataSource(input.dataSourceId);
      const touched = Touched.touched();
      const result = yield* SchemaOps.applyOperations(
        { dataSourceId: source.data_source_id, now, touched },
        input.operations,
      );
      yield* finishDatabaseWork(touched, now);
      const fresh = yield* DatabaseStore.getDataSource(source.data_source_id);
      return decodeReceipt({
        operation: request.operation,
        result: {
          ...saveable,
          ...ack,
          dataSourceId: source.data_source_id,
          schemaRevision: fresh.schema_revision,
          dataRevision: fresh.data_revision,
          created: result.created,
          clearedCells: result.clearedCells,
          affectedDataSourceIds: Touched.affected(touched, source.data_source_id).map((id) =>
            C.SpaceDataSourceId.make(id),
          ),
        },
      });
    }
    case "createView": {
      const input = request.input;
      const source = yield* DatabaseStore.getLiveDataSource(input.dataSourceId);
      const snapshot = yield* SchemaStore.load(source.data_source_id);
      if (input.block) {
        const [row] =
          yield* sql`SELECT 1 FROM spaces_blocks WHERE block_id = ${input.block.blockId} AND page_id = ${input.block.pageId} AND deleted = 0`;
        if (!row) return yield* notFound("block", input.block.blockId);
      }
      const viewId = yield* ViewStore.createView({
        snapshot,
        databaseId: source.database_id,
        definition: {
          name: input.name,
          type: input.type,
          filter: input.filter ?? null,
          sorts: input.sorts ?? [],
          group: input.group ?? null,
          subGroup: input.subGroup ?? null,
          properties: input.properties ?? [],
          layout: input.layout ?? {},
        },
        beforeViewId: input.beforeViewId ?? null,
        ownerBlockId: input.block?.blockId ?? null,
        now: iso,
      });
      const block = input.block
        ? yield* BlockEdits.editViewIds({
            target: input.block,
            databaseId: source.database_id,
            edit: (ids) => [...ids, viewId],
            mutationId: input.mutationId,
            nowMs: now,
            requestBytes,
          })
        : undefined;
      const revision = yield* DatabaseStore.touchDatabase(source.database_id, iso);
      return decodeReceipt({
        operation: request.operation,
        result: { ...saveable, ...ack, viewId, revision, ...(block ? { block } : {}) },
      });
    }
    case "updateView": {
      const input = request.input;
      const record = yield* ViewStore.getView(input.viewId);
      yield* Liveness.assertDatabaseLive(record.database_id);
      const snapshot = yield* SchemaStore.load(record.data_source_id);
      yield* ViewStore.updateView({
        snapshot,
        record,
        patch: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.filter === undefined ? {} : { filter: input.filter }),
          ...(input.sorts === undefined ? {} : { sorts: input.sorts }),
          ...(input.group === undefined ? {} : { group: input.group }),
          ...(input.subGroup === undefined ? {} : { subGroup: input.subGroup }),
          ...(input.properties === undefined ? {} : { properties: input.properties }),
          ...(input.layout === undefined ? {} : { layout: input.layout }),
          ...(input.beforeViewId === undefined ? {} : { beforeViewId: input.beforeViewId }),
        },
        now: iso,
      });
      const revision = yield* DatabaseStore.touchDatabase(record.database_id, iso);
      return decodeReceipt({
        operation: request.operation,
        result: { ...saveable, ...ack, viewId: input.viewId, revision },
      });
    }
    case "deleteView": {
      const input = request.input;
      const record = yield* ViewStore.getView(input.viewId);
      yield* Liveness.assertDatabaseLive(record.database_id);
      yield* ViewStore.deleteView(record);
      const block = input.block
        ? yield* BlockEdits.editViewIds({
            target: input.block,
            databaseId: record.database_id,
            edit: (ids) => ids.filter((id) => id !== input.viewId),
            mutationId: input.mutationId,
            nowMs: now,
            requestBytes,
          })
        : undefined;
      const revision = yield* DatabaseStore.touchDatabase(record.database_id, iso);
      return decodeReceipt({
        operation: request.operation,
        result: {
          ...saveable,
          ...ack,
          viewId: input.viewId,
          revision,
          ...(block ? { block } : {}),
        },
      });
    }
    case "createRows":
    case "updateRows":
    case "moveRows":
      return yield* rowsMutation(request, meta);
  }
});
