import * as C from "@t2code/contracts/spaces";

import { type Json, type JsonObject, isObject, parseJson } from "../databases/Json.ts";
import { queryTypeOf } from "../databases/computed/Record.ts";
import type { Property, Snapshot } from "../databases/SchemaStore.ts";
import type { ViewRecord } from "../databases/Types.ts";

/** Whether a data source is inside the shared tree; the caller resolves it beforehand. */
export type InTree = (dataSourceId: string) => boolean;

export interface Column {
  readonly propertyId: string;
  readonly width?: number;
  readonly wrap?: boolean;
}

/** The saved parts of a view that sharing looks at, decoded defensively from the stored JSON. */
export interface SharedViewShape {
  readonly id: string;
  readonly type: string;
  readonly columns: readonly (Column & { readonly visible: boolean })[];
  readonly layout: JsonObject;
  readonly group: {
    readonly property: string;
    readonly by?: Json;
    readonly sort?: Json;
    readonly order?: Json;
    readonly hidden: readonly Json[];
    readonly hideEmpty?: Json;
  } | null;
}

export interface Exposed {
  /** `title` first, then the view's visible, eligible columns. */
  readonly columns: readonly Column[];
  /** Eligible properties the layout needs that are not columns. */
  readonly extras: readonly string[];
}

const KNOWN_VIEWS: ReadonlySet<string> = new Set(C.SPACE_VIEW_TYPES);
const TYPES: ReadonlySet<string> = new Set(C.SPACE_PROPERTY_TYPES);
const DATE_TYPES: ReadonlySet<string> = new Set(["date", "created_time", "last_edited_time"]);

const attempt = (json: string): Json | null => {
  try {
    return parseJson(json);
  } catch {
    return null;
  }
};

export const parseView = (record: ViewRecord): SharedViewShape => {
  const properties = attempt(record.properties);
  const layout = attempt(record.layout);
  const grouping = record.grouping === null ? null : attempt(record.grouping);
  return {
    id: record.view_id,
    type: record.type,
    columns: Array.isArray(properties)
      ? properties.flatMap((entry) =>
          isObject(entry) && typeof entry.propertyId === "string"
            ? [
                {
                  propertyId: entry.propertyId,
                  visible: entry.visible === true,
                  ...(typeof entry.width === "number" ? { width: entry.width } : {}),
                  ...(typeof entry.wrap === "boolean" ? { wrap: entry.wrap } : {}),
                },
              ]
            : [],
        )
      : [],
    layout: isObject(layout) ? layout : {},
    group:
      isObject(grouping) && typeof grouping.property === "string"
        ? {
            property: grouping.property,
            ...(grouping.by === undefined ? {} : { by: grouping.by }),
            ...(grouping.sort === undefined ? {} : { sort: grouping.sort }),
            ...(grouping.order === undefined ? {} : { order: grouping.order }),
            ...(grouping.hideEmpty === undefined ? {} : { hideEmpty: grouping.hideEmpty }),
            hidden: Array.isArray(grouping.hidden) ? grouping.hidden : [],
          }
        : null,
  };
};

interface Trace {
  readonly sources: ReadonlySet<string>;
  /** False when something the value reads cannot be trusted to be stored and current. */
  readonly clean: boolean;
}

const isComputed = (property: Property) =>
  property.type === "formula" || property.type === "rollup";

const relationTarget = (property: Property) =>
  typeof property.config.dataSourceId === "string" ? property.config.dataSourceId : undefined;

const trace = (
  snapshot: Snapshot,
  property: Property,
  memo: Map<string, Trace>,
  visiting: Set<string>,
): Trace => {
  const known = memo.get(property.id);
  if (known !== undefined) return known;
  if (visiting.has(property.id)) return { sources: new Set(), clean: true };
  visiting.add(property.id);
  const sources = new Set<string>();
  const record = property.computed;
  let clean = record !== null && record.error === undefined && !record.volatile;
  for (const ref of record?.refs ?? []) sources.add(ref.dataSourceId);
  for (const link of record?.deps.related ?? []) sources.add(link.dataSourceId);
  for (const id of record?.deps.own ?? []) {
    const dep = snapshot.byId.get(id);
    if (dep === undefined || dep.deletedAtMs !== null) {
      clean = false;
      continue;
    }
    if (dep.type === "relation") {
      const target = relationTarget(dep);
      if (target !== undefined) sources.add(target);
    } else if (isComputed(dep)) {
      const inner = trace(snapshot, dep, memo, visiting);
      for (const source of inner.sources) sources.add(source);
      if (!inner.clean) clean = false;
    }
  }
  visiting.delete(property.id);
  const result = { sources, clean } satisfies Trace;
  memo.set(property.id, result);
  return result;
};

/** The data sources a formula or rollup value can carry content from, through own chains and cycles. */
export const reads = (snapshot: Snapshot, property: Property): ReadonlySet<string> =>
  trace(snapshot, property, new Map(), new Set()).sources;

const eligibleWith = (
  snapshot: Snapshot,
  property: Property,
  inTree: InTree,
  memo: Map<string, Trace>,
): boolean => {
  if (property.deletedAtMs !== null || !TYPES.has(property.type)) return false;
  if (property.type === "relation") {
    const target = relationTarget(property);
    return target !== undefined && inTree(target);
  }
  if (!isComputed(property)) return true;
  const result = trace(snapshot, property, memo, new Set());
  if (!result.clean) return false;
  for (const source of result.sources) if (!inTree(source)) return false;
  return true;
};

/** Whether the property's values may leave the server on a public link at all. */
export const eligible = (snapshot: Snapshot, property: Property, inTree: InTree): boolean =>
  eligibleWith(snapshot, property, inTree, new Map());

const dateQueryable = (property: Property) =>
  DATE_TYPES.has(property.type) ||
  (isComputed(property) && queryTypeOf(property.computed) === "date");

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** Layout properties a view type needs (`required`) and may use (`optional`). */
export const layoutProperties = (view: SharedViewShape) => {
  const required: string[] = [];
  const optional: string[] = [];
  const preview = view.layout.cardPreview;
  switch (view.type) {
    case "table":
    case "list":
      if (view.group !== null) required.push(view.group.property);
      break;
    case "board":
    case "gallery":
      if (view.group !== null) required.push(view.group.property);
      if (
        isObject(preview) &&
        preview.kind === "property" &&
        typeof preview.propertyId === "string"
      )
        optional.push(preview.propertyId);
      break;
    case "chart": {
      if (view.group !== null) required.push(view.group.property);
      const y = view.layout.y;
      if (isObject(y) && typeof y.property === "string") required.push(y.property);
      break;
    }
    case "calendar": {
      const id = text(view.layout.datePropertyId);
      if (id !== undefined) required.push(id);
      break;
    }
    case "timeline": {
      const start = text(view.layout.startPropertyId);
      const end = text(view.layout.endPropertyId);
      if (start !== undefined) required.push(start);
      if (end !== undefined) optional.push(end);
      break;
    }
  }
  const dated = view.type === "calendar" || view.type === "timeline";
  const missing =
    (view.type === "calendar" && required.length === 0) ||
    (view.type === "timeline" && required.length === 0) ||
    (view.type === "chart" && view.group === null);
  return { required, optional, dated, missing };
};

/** The questions of a form view that may be asked on a link: usable, answerable, in layout order. */
export const formQuestionIds = (view: SharedViewShape): readonly string[] => {
  const questions = view.layout.questions;
  if (!Array.isArray(questions)) return [];
  const ids: string[] = [];
  for (const entry of questions) {
    if (isObject(entry) && typeof entry.propertyId === "string" && !ids.includes(entry.propertyId))
      ids.push(entry.propertyId);
  }
  return ids;
};

const formExposed = (
  snapshot: Snapshot,
  view: SharedViewShape,
  usable: (id: string, dated: boolean) => boolean,
): Exposed => {
  const extras = formQuestionIds(view).filter((id) => {
    if (id === C.SPACE_TITLE_PROPERTY_ID) return false;
    const property = snapshot.byId.get(id);
    return property !== undefined && C.isFormAnswerType(property.type) && usable(id, false);
  });
  return { columns: [{ propertyId: C.SPACE_TITLE_PROPERTY_ID }], extras };
};

/** What a view shows on a link, or null when the view cannot be served (omitted everywhere). */
export const exposed = (
  snapshot: Snapshot,
  view: SharedViewShape,
  inTree: InTree,
): Exposed | null => {
  if (!KNOWN_VIEWS.has(view.type)) return null;
  const memo = new Map<string, Trace>();
  const usable = (id: string, dated: boolean) => {
    const property = snapshot.byId.get(id);
    return (
      property !== undefined &&
      eligibleWith(snapshot, property, inTree, memo) &&
      (!dated || dateQueryable(property))
    );
  };
  if (view.type === "form") return formExposed(snapshot, view, usable);
  const { required, optional, dated, missing } = layoutProperties(view);
  if (missing) return null;
  for (const id of required) if (!usable(id, dated)) return null;
  const columns: Column[] = [];
  const titleEntry = view.columns.find((column) => column.propertyId === C.SPACE_TITLE_PROPERTY_ID);
  columns.push({
    propertyId: C.SPACE_TITLE_PROPERTY_ID,
    ...(titleEntry?.width === undefined ? {} : { width: titleEntry.width }),
    ...(titleEntry?.wrap === undefined ? {} : { wrap: titleEntry.wrap }),
  });
  const shown = new Set<string>([C.SPACE_TITLE_PROPERTY_ID]);
  for (const column of view.columns) {
    if (!column.visible || shown.has(column.propertyId) || !usable(column.propertyId, false))
      continue;
    shown.add(column.propertyId);
    columns.push({
      propertyId: column.propertyId,
      ...(column.width === undefined ? {} : { width: column.width }),
      ...(column.wrap === undefined ? {} : { wrap: column.wrap }),
    });
  }
  const extras: string[] = [];
  for (const id of [...required, ...optional.filter((candidate) => usable(candidate, dated))]) {
    if (shown.has(id)) continue;
    shown.add(id);
    extras.push(id);
  }
  return { columns, extras };
};
