import {
  type CompiledFormula,
  type FormulaValue,
  type RollupFunction,
  evaluate,
  evaluateRollup,
} from "@t2code/shared/formula";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as SpacesSql from "../../SpacesSql.ts";
import type { CellRow } from "../CellCodec.ts";
import * as CellStore from "../CellStore.ts";
import * as RelationStore from "../RelationStore.ts";
import * as SchemaStore from "../SchemaStore.ts";
import type { Property, Snapshot } from "../SchemaStore.ts";
import { type ComputedRecord } from "./Record.ts";
import { type PageFields, readStored } from "./Values.ts";

const CHUNK = 200;

interface EvaluateInput {
  readonly snapshot: Snapshot;
  readonly pageIds: readonly string[];
  /** Computed properties of the snapshot's data source to evaluate. */
  readonly properties: readonly Property[];
  readonly now: number;
  readonly timeZone: string;
  /**
   * Shared across calls: every evaluation adds the steps it spent, and rows stop being evaluated
   * once `steps` reaches `limit` (after at least one row, so a batch always progresses).
   */
  readonly budget?: { steps: number; readonly limit: number };
}

/** Steps charged per evaluated property of a row, so cheap rows still add up. */
const ROW_STEPS = 10;

interface Evaluated {
  /** The leading rows of `pageIds` that were evaluated; the rest ran out of budget. */
  readonly done: readonly string[];
  readonly values: ReadonlyMap<string, ReadonlyMap<string, FormulaValue>>;
  titleOf(pageId: string): string | undefined;
  /** Option colors by name for rollups that show select values. */
  colorsOf(propertyId: string): ((name: string) => string | undefined) | undefined;
}

interface PageRow extends PageFields {
  readonly page_id: string;
  readonly data_source_id: string | null;
}

const asCompiled = (record: ComputedRecord): CompiledFormula | undefined =>
  record.ast === undefined
    ? undefined
    : {
        v: 1,
        ast: record.ast,
        refs: record.refs ?? [],
        type: record.type,
        deps: record.deps,
        volatile: record.volatile,
      };

/** Orders properties so each follows the computed properties of the same row it reads. */
const ordered = (requested: readonly Property[], snapshot: Snapshot) => {
  // Volatile inputs have no stored cells, so an unrequested one is evaluated alongside.
  const properties = [...requested];
  for (let index = 0; index < properties.length; index += 1)
    for (const id of properties[index]!.computed?.deps.own ?? []) {
      const dep = snapshot.byId.get(id);
      if (
        dep?.computed?.volatile === true &&
        dep.computed.error === undefined &&
        !properties.some((property) => property.id === id)
      )
        properties.push(dep);
    }
  const ids = new Set(properties.map((property) => property.id));
  const done = new Set<string>();
  const result: Property[] = [];
  const visit = (property: Property, path: Set<string>) => {
    if (done.has(property.id) || path.has(property.id)) return;
    path.add(property.id);
    for (const id of property.computed?.deps.own ?? []) {
      const next = properties.find((candidate) => candidate.id === id);
      if (next !== undefined && ids.has(id)) visit(next, path);
    }
    done.add(property.id);
    result.push(property);
  };
  for (const property of properties) visit(property, new Set());
  return result;
};

const pageRows = Effect.fn("SpacesDatabases.loadPageFields")(function* (
  ids: readonly string[],
  live: boolean,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const found: PageRow[] = [];
  for (let start = 0; start < ids.length; start += CHUNK) {
    const chunk = ids.slice(start, start + CHUNK);
    found.push(
      ...(live
        ? yield* sql<PageRow>`SELECT page_id, title, created_at, updated_at, row_seq, data_source_id FROM spaces_pages
            WHERE page_id IN ${sql.in(chunk)} AND data_source_id IS NOT NULL
            AND trash_batch_id IS NULL AND row_template = 0`
        : yield* sql<PageRow>`SELECT page_id, title, created_at, updated_at, row_seq, data_source_id FROM spaces_pages
            WHERE page_id IN ${sql.in(chunk)}`),
    );
  }
  return found;
});

const readCells = (pageIds: readonly string[], propertyIds: readonly string[]) =>
  pageIds.length === 0 || propertyIds.length === 0
    ? Effect.succeed(new Map<string, Map<string, CellRow[]>>())
    : CellStore.readCells(pageIds, propertyIds);

const refsOf = (rows: readonly CellRow[] | undefined) =>
  (rows ?? []).flatMap((row) => (row.ref === null ? [] : [row.ref]));

/**
 * Evaluates computed properties for a set of rows, one relation away from each (plan 2.6). It
 * only reads: the loader preloads every row, related row and cell the definitions can touch, in
 * chunks, and the engine reads from those maps.
 */
export const rows = Effect.fn("SpacesDatabases.evaluateRows")(function* (input: EvaluateInput) {
  const { snapshot } = input;
  const ownSource = snapshot.source.data_source_id;
  const props = ordered(input.properties, snapshot);
  const ownIds = new Set<string>();
  const related = new Map<string, { dataSourceId: string; propertyIds: Set<string> }>();
  for (const property of props) {
    for (const id of property.computed?.deps.own ?? []) ownIds.add(id);
    for (const link of property.computed?.deps.related ?? []) {
      const entry = related.get(link.relationPropertyId) ?? {
        dataSourceId: link.dataSourceId,
        propertyIds: new Set<string>(),
      };
      for (const id of link.propertyIds) entry.propertyIds.add(id);
      related.set(link.relationPropertyId, entry);
    }
  }
  const fields = new Map<string, PageFields & { data_source_id: string | null }>();
  for (const row of yield* pageRows(input.pageIds, false)) fields.set(row.page_id, row);
  const cells = yield* readCells(input.pageIds, [...ownIds]);
  // Relation properties read on own rows: which targets are live, with their titles.
  const live = new Set<string>();
  const ownRelations = [...ownIds].filter((id) => snapshot.byId.get(id)?.type === "relation");
  const targetsOf = new Set<string>();
  for (const pageId of input.pageIds)
    for (const id of ownRelations)
      for (const ref of refsOf(cells.get(pageId)?.get(id))) targetsOf.add(ref);
  for (const row of yield* pageRows([...targetsOf], true)) {
    fields.set(row.page_id, row);
    live.add(row.page_id);
  }
  // Cells of related rows, per data source, and the data sources' schemas.
  const targetSnapshots = new Map<string, Snapshot>();
  const targetCells = new Map<string, Map<string, CellRow[]>>();
  const perSource = new Map<string, { pages: Set<string>; propertyIds: Set<string> }>();
  for (const [relationId, link] of related) {
    const entry = perSource.get(link.dataSourceId) ?? {
      pages: new Set<string>(),
      propertyIds: new Set<string>(),
    };
    for (const pageId of input.pageIds)
      for (const ref of refsOf(cells.get(pageId)?.get(relationId)))
        if (live.has(ref)) entry.pages.add(ref);
    for (const id of link.propertyIds) entry.propertyIds.add(id);
    perSource.set(link.dataSourceId, entry);
  }
  const far = new Set<string>();
  for (const [dataSourceId, entry] of perSource) {
    const loaded =
      dataSourceId === ownSource
        ? snapshot
        : Option.getOrUndefined(yield* SchemaStore.load(dataSourceId).pipe(Effect.option));
    if (loaded === undefined) continue;
    targetSnapshots.set(dataSourceId, loaded);
    const found = yield* readCells([...entry.pages], [...entry.propertyIds]);
    for (const [pageId, byProperty] of found) {
      targetCells.set(pageId, new Map(byProperty));
      for (const [propertyId, rowsOfProperty] of byProperty)
        if (loaded.byId.get(propertyId)?.type === "relation")
          for (const ref of refsOf(rowsOfProperty)) far.add(ref);
    }
  }
  for (const row of yield* pageRows(
    [...far].filter((id) => !live.has(id)),
    true,
  )) {
    fields.set(row.page_id, row);
    live.add(row.page_id);
  }
  const results = new Map<string, Map<string, FormulaValue>>();
  const snapshotOf = (dataSourceId: string) =>
    dataSourceId === ownSource ? snapshot : targetSnapshots.get(dataSourceId);

  const readOn = (pageId: string, dataSourceId: string, propertyId: string): FormulaValue => {
    const computed = results.get(pageId)?.get(propertyId);
    if (computed !== undefined) return computed;
    const property = snapshotOf(dataSourceId)?.byId.get(propertyId);
    const page = fields.get(pageId);
    if (property === undefined || page === undefined) return null;
    const rowCells = cells.get(pageId)?.get(propertyId) ?? targetCells.get(pageId)?.get(propertyId);
    if (property.type === "relation") {
      const targetSource = RelationStore.relationOf(property).dataSourceId;
      return refsOf(rowCells)
        .filter((ref) => live.has(ref))
        .map((ref) => ({ kind: "page" as const, id: ref, ds: targetSource }));
    }
    return readStored(property, rowCells ?? [], page);
  };

  const colors = new Map<string, (name: string) => string | undefined>();
  const evaluateOne = (property: Property, pageId: string): FormulaValue => {
    const record = property.computed;
    if (record === null) return null;
    if (record.kind === "formula") {
      const compiled = asCompiled(record);
      if (compiled === undefined) return null;
      return evaluate(compiled, {
        now: input.now,
        timeZone: input.timeZone,
        ...(input.budget === undefined ? {} : { meter: input.budget }),
        row: { id: pageId, dataSourceId: ownSource },
        read: (page, propertyId) => readOn(page.id, page.dataSourceId, propertyId),
        titleOf: (id) => fields.get(id)?.title,
      });
    }
    const relationId = String(property.config.relationPropertyId);
    const targetId = String(property.config.targetPropertyId);
    const link = related.get(relationId);
    if (link === undefined || record.targetType === undefined) return null;
    const perPage = refsOf(cells.get(pageId)?.get(relationId))
      .filter((ref) => live.has(ref))
      .map((ref) => readOn(ref, link.dataSourceId, targetId));
    if (input.budget !== undefined) input.budget.steps += perPage.length;
    return evaluateRollup(
      String(property.config.function) as RollupFunction,
      perPage,
      record.targetType,
      { timeZone: input.timeZone },
    );
  };

  const done: string[] = [];
  for (const pageId of input.pageIds) {
    const budget = input.budget;
    if (budget !== undefined && done.length > 0 && budget.steps >= budget.limit) break;
    const row = new Map<string, FormulaValue>();
    results.set(pageId, row);
    for (const property of props) row.set(property.id, evaluateOne(property, pageId));
    if (budget !== undefined) budget.steps += ROW_STEPS * props.length;
    done.push(pageId);
  }
  for (const property of props) {
    if (property.computed?.kind !== "rollup") continue;
    const target = snapshotOf(
      related.get(String(property.config.relationPropertyId))?.dataSourceId ?? "",
    )?.byId.get(String(property.config.targetPropertyId));
    if (target === undefined || target.options.length === 0) continue;
    const byName = new Map(target.options.map((option) => [option.name, option.color]));
    colors.set(property.id, (name) => {
      const color = byName.get(name);
      return color === undefined || color === "default" ? undefined : color;
    });
  }
  return {
    done,
    values: results,
    titleOf: (id) => fields.get(id)?.title,
    colorsOf: (propertyId) => colors.get(propertyId),
  } satisfies Evaluated;
});
