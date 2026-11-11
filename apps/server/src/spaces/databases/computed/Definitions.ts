import {
  FORMULA_VERSION,
  type CompiledFormula,
  type FormulaDiagnostic,
  type FormulaType,
  type RollupFunction,
  compile,
  recheck,
  renderSource,
  rollupResultType,
  typeLabel,
} from "@t2code/shared/formula";
import * as Effect from "effect/Effect";

import * as SpacesSql from "../../SpacesSql.ts";
import * as DatabaseStore from "../DatabaseStore.ts";
import * as RelationStore from "../RelationStore.ts";
import * as SchemaStore from "../SchemaStore.ts";
import type { Property, Snapshot } from "../SchemaStore.ts";
import type { Touched } from "../Touched.ts";
import { dbError, isoNow } from "../Types.ts";
import * as ViewStore from "../ViewStore.ts";
import * as Deps from "./Deps.ts";
import * as Dirty from "./Dirty.ts";
import {
  type ComputedRecord,
  currentVersion,
  emptyDeps,
  queryTypeOf,
  serializeRecord,
} from "./Record.ts";
import * as ComputedSchema from "./Schema.ts";

interface Context {
  readonly dataSourceId: string;
  readonly now: number;
  readonly touched: Touched;
}

type Compiled = { readonly record: ComputedRecord } | { readonly message: string };

const isComputed = (property: Property) =>
  property.type === "formula" || property.type === "rollup";

const lineColumn = (text: string, offset: number) => {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return `${line}:${offset - (before.lastIndexOf("\n") + 1) + 1}`;
};

const describe = (expression: string, diagnostics: readonly FormulaDiagnostic[]) => {
  const first = diagnostics[0];
  return first === undefined
    ? "The formula could not be checked."
    : `${lineColumn(expression, first.start)} ${first.message}`;
};

/** Stored result type: a formula that ends as `any` or `empty` is kept as text. */
const storedType = (type: FormulaType): FormulaType =>
  type === "any" || type === "empty" ? "text" : type;

const fromCompiled = (compiled: CompiledFormula): ComputedRecord => ({
  v: FORMULA_VERSION,
  kind: "formula",
  ast: compiled.ast,
  refs: compiled.refs,
  type: storedType(compiled.type),
  deps: compiled.deps,
  volatile: compiled.volatile,
});

const failed = (kind: ComputedRecord["kind"], message: string, old?: ComputedRecord | null) =>
  ({
    record: {
      v: FORMULA_VERSION,
      kind,
      ...(old?.ast === undefined ? {} : { ast: old.ast }),
      ...(old?.refs === undefined ? {} : { refs: old.refs }),
      type: "text",
      deps: emptyDeps,
      volatile: false,
      error: message,
    },
  }) satisfies Compiled;

const compileFormula = (
  snapshot: Snapshot,
  others: ReadonlyMap<string, Snapshot>,
  property: Property,
  mode: "save" | "refresh",
): Compiled => {
  const expression =
    typeof property.config.expression === "string" ? property.config.expression : "";
  const schema = ComputedSchema.forSource(snapshot, others);
  const old = property.computed;
  if (expression.trim() === "")
    return {
      record: {
        v: FORMULA_VERSION,
        kind: "formula",
        ast: { k: "str", v: "" },
        refs: [],
        type: "text",
        deps: emptyDeps,
        volatile: false,
      },
    };
  const name = (dataSourceId: string, propertyId: string) =>
    (dataSourceId === snapshot.source.data_source_id
      ? snapshot
      : others.get(dataSourceId)
    )?.byId.get(propertyId)?.name;
  if (
    mode === "refresh" &&
    old !== null &&
    old.kind === "formula" &&
    old.ast !== undefined &&
    currentVersion(old)
  ) {
    const result = recheck(
      {
        v: 1,
        ast: old.ast,
        refs: old.refs ?? [],
        type: old.type,
        deps: old.deps,
        volatile: old.volatile,
      },
      schema,
    );
    return result.compiled === null
      ? failed("formula", result.diagnostics[0]?.message ?? "The formula has an error.", old)
      : { record: fromCompiled(result.compiled) };
  }
  const source =
    mode === "refresh" && old?.refs !== undefined
      ? renderSource(expression, old.refs, name)
      : expression;
  const result = compile(source, schema);
  if (result.compiled === null)
    return mode === "save"
      ? { message: describe(source, result.diagnostics) }
      : failed("formula", result.diagnostics[0]?.message ?? "The formula has an error.");
  return { record: fromCompiled(result.compiled) };
};

const compileRollup = (
  snapshot: Snapshot,
  others: ReadonlyMap<string, Snapshot>,
  property: Property,
  mode: "save" | "refresh",
): Compiled => {
  const bad = (message: string) =>
    mode === "save" ? { message } : failed("rollup", message, property.computed);
  const relation = snapshot.byId.get(String(property.config.relationPropertyId));
  if (relation === undefined || relation.deletedAtMs !== null || relation.type !== "relation")
    return bad("The rollup needs a relation property of this database.");
  const targetSource = RelationStore.relationOf(relation).dataSourceId;
  const target =
    targetSource === snapshot.source.data_source_id ? snapshot : others.get(targetSource);
  const picked = target?.byId.get(String(property.config.targetPropertyId));
  if (target === undefined || picked === undefined || picked.deletedAtMs !== null)
    return bad("The rolled-up property no longer exists.");
  if (picked.type === "rollup") return bad("A rollup cannot read another rollup.");
  if (picked.computed?.error !== undefined)
    return bad(`The property "${picked.name}" has an error.`);
  if (picked.computed?.volatile === true)
    return bad(`The property "${picked.name}" uses now() or today() and cannot be rolled up.`);
  const targetType = ComputedSchema.formulaTypeOf(picked);
  const fn = property.config.function;
  const type = typeof fn === "string" ? rollupResultType(fn as RollupFunction, targetType) : null;
  if (type === null)
    return bad(`"${String(fn)}" cannot be used on ${typeLabel(targetType)} properties.`);
  return {
    record: {
      v: FORMULA_VERSION,
      kind: "rollup",
      type,
      targetType,
      deps: {
        own: [relation.id],
        related: [
          {
            relationPropertyId: relation.id,
            dataSourceId: targetSource,
            propertyIds: [...new Set([picked.id, "title"])],
          },
        ],
      },
      volatile: false,
    },
  };
};

const compileProperty = (
  snapshot: Snapshot,
  others: ReadonlyMap<string, Snapshot>,
  property: Property,
  mode: "save" | "refresh",
) =>
  property.type === "rollup"
    ? compileRollup(snapshot, others, property, mode)
    : compileFormula(snapshot, others, property, mode);

const store = Effect.fn("SpacesDatabases.storeComputed")(function* (
  dataSourceId: string,
  propertyId: string,
  record: ComputedRecord | null,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_db_properties SET computed = ${record === null ? null : serializeRecord(record)}
    WHERE data_source_id = ${dataSourceId} AND property_id = ${propertyId}`;
});

const key = (dataSourceId: string, propertyId: string) => `${dataSourceId}\u0000${propertyId}`;
const MAX_LAYERS = 15;

const nameOf = Effect.fn("SpacesDatabases.computedName")(function* (nodeKey: string) {
  const sql = yield* SpacesSql.SpacesSql;
  const [dataSourceId, propertyId] = nodeKey.split("\u0000");
  const [row] = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM spaces_db_properties WHERE data_source_id = ${dataSourceId!} AND property_id = ${propertyId!}`;
  return row?.name ?? propertyId!;
});

/** Rejects a definition that reads itself (property level) or sits in a chain over 15 layers. */
const checkGraph = Effect.fn("SpacesDatabases.checkGraph")(function* (
  dataSourceId: string,
  propertyId: string,
) {
  const start = key(dataSourceId, propertyId);
  const sql = yield* SpacesSql.SpacesSql;
  const down = new Map<string, readonly string[]>();
  const up = new Map<string, readonly string[]>();
  const layer = new Set<string>();
  const queue = [start];
  for (let node = queue.pop(); node !== undefined; node = queue.pop()) {
    if (down.has(node)) continue;
    const [ds, id] = node.split("\u0000");
    const [computed] = yield* sql`SELECT 1 FROM spaces_db_properties
      WHERE data_source_id = ${ds!} AND property_id = ${id!} AND computed IS NOT NULL`;
    if (computed) layer.add(node);
    const children = (yield* Deps.depsOf(ds!, id!)).map((row) =>
      key(row.dep_data_source_id, row.dep_property_id),
    );
    down.set(node, children);
    queue.push(...children);
  }
  const upQueue = [start];
  for (let node = upQueue.pop(); node !== undefined; node = upQueue.pop()) {
    if (up.has(node)) continue;
    const [ds, id] = node.split("\u0000");
    const parents = (yield* Deps.dependentsOf(ds!, id!)).map((row) =>
      key(row.data_source_id, row.property_id),
    );
    up.set(node, parents);
    upQueue.push(...parents);
  }
  const onPath: string[] = [];
  const depth = new Map<string, number>();
  let cycle: string[] | undefined;
  const walk = (node: string): number => {
    if (cycle !== undefined) return 0;
    const at = onPath.indexOf(node);
    if (at >= 0) {
      cycle = [...onPath.slice(at), node];
      return 0;
    }
    const known = depth.get(node);
    if (known !== undefined) return known;
    onPath.push(node);
    const children = down.get(node) ?? [];
    let best = 0;
    for (const child of children) best = Math.max(best, walk(child));
    onPath.pop();
    const layers = (layer.has(node) ? 1 : 0) + best;
    depth.set(node, layers);
    return layers;
  };
  const below = walk(start);
  if (cycle !== undefined) {
    const names: string[] = [];
    for (const node of cycle) names.push(yield* nameOf(node));
    return yield* dbError("cycle", propertyId, `Circular reference: ${names.join(" → ")}`);
  }
  const heights = new Map<string, number>();
  const height = (node: string, seen: ReadonlySet<string>): number => {
    const known = heights.get(node);
    if (known !== undefined) return known;
    let best = 0;
    for (const parent of up.get(node) ?? [])
      if (!seen.has(parent)) best = Math.max(best, 1 + height(parent, new Set([...seen, node])));
    heights.set(node, best);
    return best;
  };
  if (below + height(start, new Set()) > MAX_LAYERS)
    return yield* dbError(
      "invalid_property_config",
      propertyId,
      `Too many layers of formulas and rollups (${MAX_LAYERS} at most).`,
    );
});

/** Compiles or validates a formula or rollup being saved, stores it and queues its rows. */
export const define = Effect.fn("SpacesDatabases.defineComputed")(function* (
  ctx: Context,
  propertyId: string,
) {
  const snapshot = yield* SchemaStore.load(ctx.dataSourceId);
  const property = yield* SchemaStore.liveProperty(snapshot, propertyId);
  const others = yield* ComputedSchema.loadOthers(snapshot);
  const compiled = compileProperty(snapshot, others, property, "save");
  if ("message" in compiled)
    return yield* dbError("invalid_property_config", propertyId, compiled.message);
  const before = queryTypeOf(property.computed);
  yield* store(ctx.dataSourceId, propertyId, compiled.record);
  yield* Deps.write(ctx.dataSourceId, propertyId, compiled.record.deps);
  if (before !== undefined && before !== queryTypeOf(compiled.record))
    yield* ViewStore.strip(
      ctx.dataSourceId,
      {
        propertyId,
        column: false,
        filters: true,
        sorts: true,
        groups: true,
        dateReference: queryTypeOf(compiled.record) !== "date",
      },
      isoNow(ctx.now),
    );
  yield* checkGraph(ctx.dataSourceId, propertyId);
  yield* Dirty.enqueueSource(ctx.dataSourceId);
});

/** The property stopped being computed: no definition, no dependencies. */
export const remove = Effect.fn("SpacesDatabases.removeComputed")(function* (
  dataSourceId: string,
  propertyId: string,
) {
  yield* store(dataSourceId, propertyId, null);
  yield* Deps.clear(dataSourceId, propertyId);
});

const sameDefinition = (a: ComputedRecord | null, b: ComputedRecord) =>
  a !== null &&
  JSON.stringify([a.type, a.targetType, a.deps, a.volatile, a.error ?? null]) ===
    JSON.stringify([b.type, b.targetType, b.deps, b.volatile, b.error ?? null]);

/** Computed properties of `sources` and of every data source that reads them, inputs first. */
const orderedProperties = Effect.fn("SpacesDatabases.orderComputed")(function* (
  sources: ReadonlySet<string>,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const reached = new Set(sources);
  // A Set visits entries added while it is iterated, so this walks to the transitive readers.
  for (const id of reached)
    for (const reader of yield* Deps.sourcesReading(id)) reached.add(reader);
  type Node = { readonly data_source_id: string; readonly property_id: string };
  const readers = yield* sql<Node>`SELECT data_source_id, property_id FROM spaces_db_properties
    WHERE data_source_id IN ${sql.in([...reached])} AND type IN ('formula', 'rollup') AND deleted_at_ms IS NULL`;
  // An errored or never-compiled record has no dependencies to find it by; it is rechecked when a
  // data source it might read through a relation changes.
  const recoverable =
    yield* sql<Node>`SELECT p.data_source_id, p.property_id FROM spaces_db_properties p
    WHERE p.type IN ('formula', 'rollup') AND p.deleted_at_ms IS NULL
    AND (p.computed IS NULL OR json_extract(p.computed, '$.error') IS NOT NULL)
    AND p.data_source_id IN (SELECT r.data_source_id FROM spaces_db_properties r
      WHERE r.type = 'relation' AND r.deleted_at_ms IS NULL
      AND json_extract(r.config, '$.dataSourceId') IN ${sql.in([...sources])})`;
  const nodes = [...readers, ...recoverable.filter((node) => !reached.has(node.data_source_id))];
  const ids = new Set(nodes.map((node) => key(node.data_source_id, node.property_id)));
  const remaining = new Map<string, Set<string>>();
  for (const node of nodes) {
    const nodeKey = key(node.data_source_id, node.property_id);
    const needs = new Set<string>();
    for (const dep of yield* Deps.depsOf(node.data_source_id, node.property_id)) {
      const depKey = key(dep.dep_data_source_id, dep.dep_property_id);
      if (depKey !== nodeKey && ids.has(depKey)) needs.add(depKey);
    }
    remaining.set(nodeKey, needs);
  }
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, needs]) => needs.size === 0).map(([id]) => id);
    const next = ready.length > 0 ? ready : [remaining.keys().next().value!];
    for (const id of next) {
      remaining.delete(id);
      order.push(id);
      for (const needs of remaining.values()) needs.delete(id);
    }
  }
  return order;
});

/**
 * Brings every definition affected by a schema change back in line (plan 2.4): recheck against
 * the current schema, and when the type, dependencies, volatility or error changed, store it,
 * queue the rows and strip saved views that can no longer filter, sort or group by it.
 */
export const refresh = Effect.fn("SpacesDatabases.refreshComputed")(function* (
  ctx: Pick<Context, "now" | "touched">,
  sources: ReadonlySet<string>,
) {
  const iso = isoNow(ctx.now);
  for (const node of yield* orderedProperties(sources)) {
    const [dataSourceId, propertyId] = node.split("\u0000");
    const snapshot = yield* SchemaStore.load(dataSourceId!);
    const property = snapshot.byId.get(propertyId!);
    if (property === undefined || property.deletedAtMs !== null || !isComputed(property)) continue;
    const others = yield* ComputedSchema.loadOthers(snapshot);
    const compiled = compileProperty(snapshot, others, property, "refresh");
    if ("message" in compiled) continue;
    if (sameDefinition(property.computed, compiled.record)) continue;
    yield* store(dataSourceId!, propertyId!, compiled.record);
    yield* Deps.write(dataSourceId!, propertyId!, compiled.record.deps);
    yield* DatabaseStore.bumpSchema(dataSourceId!, iso);
    ctx.touched.schema.add(dataSourceId!);
    yield* Dirty.enqueueSource(dataSourceId!);
    const before = queryTypeOf(property.computed);
    if (before !== undefined && before !== queryTypeOf(compiled.record))
      yield* ViewStore.strip(
        dataSourceId!,
        {
          propertyId: propertyId!,
          column: false,
          filters: true,
          sorts: true,
          groups: true,
          dateReference: queryTypeOf(compiled.record) !== "date",
        },
        iso,
      );
  }
});

/**
 * After a schema mutation: rows of data sources that read a changed input are recomputed, and
 * the definitions are rechecked. `changed` are inputs whose values or meaning changed in place.
 */
export const afterSchema = Effect.fn("SpacesDatabases.afterSchema")(function* (
  ctx: Context,
  changed: ReadonlySet<string>,
  redefined: ReadonlySet<string>,
) {
  for (const propertyId of changed)
    for (const dependent of yield* Deps.dependentsOf(ctx.dataSourceId, propertyId))
      yield* Dirty.enqueueSource(dependent.data_source_id);
  if (redefined.size > 0) {
    const snapshot = yield* SchemaStore.load(ctx.dataSourceId);
    if (
      [...redefined].some(
        (id) => snapshot.byId.get(id) !== undefined && isComputed(snapshot.byId.get(id)!),
      )
    )
      yield* Dirty.enqueueSource(ctx.dataSourceId);
  }
  yield* refresh(ctx, new Set([ctx.dataSourceId, ...ctx.touched.schema]));
});

/** Compiles formulas and rollups that predate the computed column (first touch). */
export const ensureCompiled = Effect.fn("SpacesDatabases.ensureCompiled")(function* (
  ctx: Pick<Context, "now" | "touched">,
  snapshot: Snapshot,
) {
  if (!snapshot.live.some((property) => isComputed(property) && property.computed === null))
    return false;
  yield* refresh(ctx, new Set([snapshot.source.data_source_id]));
  return true;
});
