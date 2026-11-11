import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { byteLength, databaseLimits, ensureDatabaseLimit, ensureLimit } from "../CorePolicy.ts";
import * as PageStore from "../PageStore.ts";
import * as PageUpdate from "../PageUpdate.ts";
import * as SearchStore from "../SearchStore.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as CellCodec from "./CellCodec.ts";
import * as CellStore from "./CellStore.ts";
import * as DatabaseStore from "./DatabaseStore.ts";
import * as Ids from "./Ids.ts";
import type { Json } from "./Json.ts";
import { POSITION_GAP, positionsBetween } from "./Position.ts";
import * as RelationStore from "./RelationStore.ts";
import * as SchemaStore from "./SchemaStore.ts";
import type { Property, Snapshot } from "./SchemaStore.ts";
import type { Touched } from "./Touched.ts";
import { dbError, isoNow, trashed } from "./Types.ts";

/** A page that is a non-trashed row or template of `dataSourceId`. */
const loadRow = Effect.fn("SpacesDatabases.loadRow")(function* (
  pageId: string,
  dataSourceId: string,
) {
  const page = yield* PageStore.load(C.SpacePageId.make(pageId));
  if (page.data_source_id !== dataSourceId) return yield* dbError("not_a_row");
  if (page.trash_batch_id !== null) return yield* trashed();
  return page;
});

/**
 * Writes one cell. Null clears. Relations go through the relation store so twins stay mirrored.
 * Returns whether the stored value changed.
 */
const writeCell = Effect.fn("SpacesDatabases.writeCell")(function* (input: {
  readonly snapshot: Snapshot;
  readonly property: Property;
  readonly pageId: string;
  readonly value: Json | null;
  readonly touched: Touched;
}) {
  const { snapshot, property, pageId, value } = input;
  if (CellCodec.readOnlyTypes.has(property.type))
    return yield* dbError("read_only_property", property.id);
  const items = value === null ? [] : yield* CellCodec.encode(property, value);
  if (property.type === "relation")
    return yield* RelationStore.write({
      snapshot,
      property,
      pageId,
      targets: items.flatMap((item) => (item.ref === null ? [] : [item.ref])),
      touched: input.touched,
    });
  return yield* CellStore.replace(pageId, snapshot.source.data_source_id, property.id, items);
});

const renumber = Effect.fn("SpacesDatabases.renumberRows")(function* (dataSourceId: string) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_pages SET row_position = r.rn * ${POSITION_GAP}
    FROM (SELECT page_id, row_number() OVER (ORDER BY row_position, row_seq) AS rn
      FROM spaces_pages WHERE data_source_id = ${dataSourceId}) r
    WHERE spaces_pages.page_id = r.page_id`;
});

/** Positions for `count` rows placed immediately before `beforeRowId`, or at the end. */
const placement = Effect.fn("SpacesDatabases.placeRows")(function* (
  dataSourceId: string,
  count: number,
  beforeRowId: string | null,
  moving: readonly string[],
) {
  const sql = yield* SpacesSql.SpacesSql;
  const exclude = moving.length === 0 ? [""] : moving;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (beforeRowId === null) {
      const [last] = yield* sql<{
        readonly max: number | null;
      }>`SELECT MAX(row_position) AS max FROM spaces_pages WHERE data_source_id = ${dataSourceId} AND page_id NOT IN ${sql.in(exclude)}`;
      return positionsBetween(last?.max ?? 0, null, count)!;
    }
    const [next] = yield* sql<{
      readonly row_position: number;
    }>`SELECT row_position FROM spaces_pages WHERE page_id = ${beforeRowId} AND data_source_id = ${dataSourceId}`;
    if (!next) return yield* dbError("not_a_row");
    const [previous] = yield* sql<{
      readonly max: number | null;
    }>`SELECT MAX(row_position) AS max FROM spaces_pages WHERE data_source_id = ${dataSourceId}
      AND row_position < ${next.row_position} AND page_id NOT IN ${sql.in(exclude)}`;
    const positions = positionsBetween(previous?.max ?? 0, next.row_position, count);
    if (positions) return positions;
    yield* renumber(dataSourceId);
  }
  return yield* new C.SpacesUnavailableError({ stage: "storage" });
});

const countCells = (drafts: readonly { readonly cells?: C.SpaceCellMap | undefined }[]) =>
  drafts.reduce((total, draft) => total + Object.keys(draft.cells ?? {}).length, 0);

export const createRows = Effect.fn("SpacesDatabases.createRows")(function* (input: {
  readonly snapshot: Snapshot;
  readonly drafts: readonly C.SpaceRowDraft[];
  readonly beforeRowId: string | null;
  readonly now: number;
  readonly touched: Touched;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  const { snapshot, drafts } = input;
  const source = snapshot.source;
  const iso = isoNow(input.now);
  yield* ensureDatabaseLimit("maxRowsPerMutation", drafts.length);
  yield* ensureDatabaseLimit("maxCellsPerMutation", countCells(drafts));
  yield* ensureDatabaseLimit("maxRowsPerDataSource", source.row_count + drafts.length);
  if (drafts.some((draft) => draft.templateId !== undefined)) return yield* dbError("unsupported");
  const [database] = yield* sql<{
    readonly space_id: string;
  }>`SELECT space_id FROM spaces_db_databases WHERE database_id = ${source.database_id}`;
  if (drafts.length === 0) return [];
  const positions = yield* placement(source.data_source_id, drafts.length, input.beforeRowId, []);
  const created: { pageId: string; number: number }[] = [];
  for (const [index, draft] of drafts.entries()) {
    const cells = { ...draft.cells };
    const titleValue = cells.title;
    delete cells.title;
    if (titleValue !== undefined && typeof titleValue !== "string")
      return yield* dbError("invalid_value", C.SPACE_TITLE_PROPERTY_ID);
    const title = titleValue ?? draft.title ?? "";
    yield* ensureLimit("maxTitleBytes", byteLength(title));
    const pageId = yield* Ids.register("page");
    const seq = source.next_row_seq + index;
    yield* sql`INSERT INTO spaces_pages (page_id, space_id, title, icon, root_order, created_at, updated_at, data_source_id, row_seq, row_position, row_template)
      VALUES (${pageId}, ${database!.space_id}, ${title}, ${draft.icon ?? null}, NULL, ${iso}, ${iso},
      ${source.data_source_id}, ${seq}, ${positions[index]!}, ${draft.asTemplate === true ? 1 : 0})`;
    yield* SearchStore.writeTitle(pageId, title);
    yield* CellStore.writeTitleMirror(pageId, source.data_source_id, title);
    for (const property of snapshot.live) {
      const supplied = cells[property.id];
      if (property.type === "status" && supplied === undefined) {
        const fallback = property.config.defaultOptionId;
        if (typeof fallback === "string")
          yield* CellStore.replace(pageId, source.data_source_id, property.id, [
            CellCodec.refItem(fallback),
          ]);
      }
    }
    for (const [propertyId, value] of Object.entries(cells)) {
      const property = yield* SchemaStore.liveProperty(snapshot, propertyId);
      yield* writeCell({ snapshot, property, pageId, value, touched: input.touched });
    }
    created.push({ pageId, number: seq });
  }
  yield* sql`UPDATE spaces_db_data_sources SET next_row_seq = next_row_seq + ${drafts.length},
    row_count = row_count + ${drafts.length} WHERE data_source_id = ${source.data_source_id}`;
  input.touched.sources.add(source.data_source_id);
  return created;
});

export const updateRows = Effect.fn("SpacesDatabases.updateRows")(function* (input: {
  readonly snapshot: Snapshot;
  readonly rows: C.SpaceRowsUpdateInput["rows"];
  readonly mutationId: string;
  readonly now: number;
  readonly touched: Touched;
}) {
  const { snapshot } = input;
  yield* ensureDatabaseLimit("maxRowsPerMutation", input.rows.length);
  yield* ensureDatabaseLimit("maxCellsPerMutation", countCells(input.rows));
  const sourceId = snapshot.source.data_source_id;
  const seen = new Set<string>();
  for (const row of input.rows) {
    if (seen.has(row.pageId)) return yield* new C.SpaceValidationError({ reason: "invalid_input" });
    seen.add(row.pageId);
    const page = yield* loadRow(row.pageId, sourceId);
    let changed = false;
    for (const [propertyId, value] of Object.entries(row.cells)) {
      const property = yield* SchemaStore.liveProperty(snapshot, propertyId);
      if (property.type === "title") {
        if (value !== null && typeof value !== "string")
          return yield* dbError("invalid_value", property.id);
        const title = value ?? "";
        yield* ensureLimit("maxTitleBytes", byteLength(title));
        changed =
          (yield* PageUpdate.apply(
            page,
            { title, icon: page.icon ?? null },
            input.mutationId,
            input.now,
            false,
          )) || changed;
        continue;
      }
      changed =
        (yield* writeCell({
          snapshot,
          property,
          pageId: page.page_id,
          value,
          touched: input.touched,
        })) || changed;
    }
    if (changed) {
      input.touched.rows.set(page.page_id, sourceId);
      input.touched.sources.add(sourceId);
    }
  }
});

export const moveRows = Effect.fn("SpacesDatabases.moveRows")(function* (input: {
  readonly snapshot: Snapshot;
  readonly pageIds: readonly string[];
  readonly beforeRowId: string | null;
  readonly touched: Touched;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  const sourceId = input.snapshot.source.data_source_id;
  yield* ensureDatabaseLimit("maxRowsPerMutation", input.pageIds.length);
  if (new Set(input.pageIds).size !== input.pageIds.length || input.pageIds.length === 0)
    return yield* new C.SpaceValidationError({ reason: "invalid_input" });
  if (input.beforeRowId !== null && input.pageIds.includes(input.beforeRowId))
    return yield* new C.SpaceValidationError({ reason: "invalid_order" });
  for (const id of input.pageIds) yield* loadRow(id, sourceId);
  if (input.beforeRowId !== null) yield* loadRow(input.beforeRowId, sourceId);
  const positions = yield* placement(
    sourceId,
    input.pageIds.length,
    input.beforeRowId,
    input.pageIds,
  );
  for (const [index, id] of input.pageIds.entries())
    yield* sql`UPDATE spaces_pages SET row_position = ${positions[index]!} WHERE page_id = ${id}`;
  input.touched.sources.add(sourceId);
});

/** Finalizes a mutation: stamps touched rows once and bumps each data source's data revision. */
export const finish = Effect.fn("SpacesDatabases.finishTouched")(function* (
  touched: Touched,
  excludeStamp: ReadonlySet<string>,
  now: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const iso = isoNow(now);
  for (const pageId of touched.rows.keys())
    if (!excludeStamp.has(pageId))
      yield* sql`UPDATE spaces_pages SET updated_at = ${iso} WHERE page_id = ${pageId}`;
  for (const id of touched.sources) yield* DatabaseStore.bumpData(id, iso);
});

const virtualCell = (property: Property, page: HydratePage): Json | undefined => {
  switch (property.type) {
    case "title":
      return page.title === "" ? undefined : page.title;
    case "created_time":
      return page.created_at;
    case "last_edited_time":
      return page.updated_at;
    case "unique_id": {
      const prefix = property.config.prefix;
      return {
        number: page.row_seq ?? 0,
        ...(typeof prefix === "string" && prefix !== "" ? { prefix } : {}),
      };
    }
    default:
      return undefined;
  }
};

export type HydratePage = Pick<
  PageStore.PageRow,
  "page_id" | "title" | "icon" | "revision" | "created_at" | "updated_at" | "row_seq"
>;

export const hydrate = Effect.fn("SpacesDatabases.hydrate")(function* (
  snapshot: Snapshot,
  pages: readonly HydratePage[],
  propertyIds: readonly string[] | undefined,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const wanted =
    propertyIds === undefined
      ? snapshot.live
      : yield* Effect.forEach(propertyIds, (id) => SchemaStore.liveProperty(snapshot, id));
  const stored = wanted.filter(
    (property) => !CellCodec.readOnlyTypes.has(property.type) && property.type !== "title",
  );
  const cells = yield* CellStore.readCells(
    pages.map((page) => page.page_id),
    stored.map((property) => property.id),
  );
  const targets = new Set<string>();
  for (const page of pages)
    for (const property of stored)
      if (property.type === "relation")
        for (const row of cells.get(page.page_id)?.get(property.id) ?? [])
          if (row.ref !== null) targets.add(row.ref);
  const live = new Map<string, { title: string; icon: string | null; data_source_id: string }>();
  const liveIds = new Set<string>();
  const ids = [...targets];
  for (let start = 0; start < ids.length; start += 200) {
    const found = yield* sql<{
      readonly page_id: string;
      readonly title: string;
      readonly icon: string | null;
      readonly data_source_id: string;
    }>`SELECT page_id, title, icon, data_source_id FROM spaces_pages
      WHERE page_id IN ${sql.in(ids.slice(start, start + 200))} AND trash_batch_id IS NULL AND data_source_id IS NOT NULL`;
    for (const row of found) {
      liveIds.add(row.page_id);
      if (live.size < databaseLimits.maxRelatedPages) live.set(row.page_id, row);
    }
  }
  const rows: C.SpaceDatabaseRow[] = pages.map((page) => {
    const values: Record<string, Json> = {};
    for (const property of wanted) {
      const value =
        property.type === "title" || CellCodec.readOnlyTypes.has(property.type)
          ? virtualCell(property, page)
          : CellCodec.decode(property, cells.get(page.page_id)?.get(property.id) ?? []);
      if (value === undefined) continue;
      if (property.type === "relation" && Array.isArray(value)) {
        const visible = value.filter((id) => typeof id === "string" && liveIds.has(id));
        if (visible.length > 0) values[property.id] = visible;
      } else values[property.id] = value;
    }
    return {
      page: {
        id: page.page_id,
        title: page.title,
        ...(page.icon ? { icon: page.icon } : {}),
        revision: page.revision,
        createdAt: page.created_at,
        updatedAt: page.updated_at,
      },
      number: page.row_seq ?? 1,
      cells: values,
    };
  });
  const related: Record<string, C.SpaceRelatedPage> = {};
  for (const [id, row] of live)
    related[id] = {
      title: row.title,
      ...(row.icon ? { icon: row.icon } : {}),
      dataSourceId: C.SpaceDataSourceId.make(row.data_source_id),
    };
  return { rows, related };
});
