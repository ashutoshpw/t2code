import type { SpaceSharedDatabaseView, SpaceSharedDatabaseRow } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";

import { canonical } from "../CorePolicy.ts";
import { type Json, type JsonObject, isObject } from "../databases/Json.ts";
import { queryTypeOf } from "../databases/computed/Record.ts";
import type { Property } from "../databases/SchemaStore.ts";
import type { ViewScope } from "./Scope.ts";

/**
 * Everything a public link returns passes through here. Each output object is built key by key
 * from an allow-list; a record, wire object or rest-keyed value is never spread into an output.
 */

const PLAIN_MARKS = new Set(["bold", "italic", "underline", "strike", "code"]);
const COLOR_MARKS = new Set(["color", "highlight"]);
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

const sanitizeMark = (mark: unknown): Json | undefined => {
  if (!isObject(mark) || typeof mark.type !== "string") return undefined;
  if (PLAIN_MARKS.has(mark.type)) return { type: mark.type, version: 1 };
  if (COLOR_MARKS.has(mark.type) && typeof mark.value === "string")
    return { type: mark.type, version: 1, value: mark.value };
  if (mark.type === "link" && typeof mark.href === "string" && SAFE_LINK.test(mark.href))
    return { type: "link", version: 1, href: mark.href };
  return undefined;
};

/** Text runs with mentions and unsafe links dropped; the text itself stays. */
const sanitizeRuns = (runs: unknown): Json[] | undefined => {
  if (!Array.isArray(runs)) return undefined;
  const out: Json[] = [];
  for (const run of runs) {
    if (!isObject(run) || typeof run.text !== "string") continue;
    const marks = Array.isArray(run.marks)
      ? run.marks.flatMap((mark) => {
          const kept = sanitizeMark(mark);
          return kept === undefined ? [] : [kept];
        })
      : [];
    out.push({ text: run.text, marks });
  }
  return out;
};

const sanitizeDate = (value: unknown): Json | undefined => {
  if (!isObject(value) || typeof value.start !== "string") return undefined;
  return {
    start: value.start,
    ...(typeof value.end === "string" ? { end: value.end } : {}),
    ...(typeof value.timeZone === "string" ? { timeZone: value.timeZone } : {}),
  };
};

/** The stored envelope of a formula or rollup value, rebuilt for the known types. */
const sanitizeComputed = (wire: unknown, related: ReadonlySet<string>): Json | undefined => {
  if (!isObject(wire)) return undefined;
  switch (wire.type) {
    case "string": {
      if (typeof wire.value !== "string") return undefined;
      const runs = wire.runs === undefined ? undefined : sanitizeRuns(wire.runs);
      return {
        type: "string",
        value: wire.value,
        ...(runs === undefined ? {} : { runs }),
        ...(typeof wire.color === "string" ? { color: wire.color } : {}),
      };
    }
    case "number":
      return typeof wire.value === "number" && Number.isFinite(wire.value)
        ? { type: "number", value: wire.value }
        : undefined;
    case "boolean":
      return typeof wire.value === "boolean" ? { type: "boolean", value: wire.value } : undefined;
    case "date": {
      const value = sanitizeDate(wire.value);
      return value === undefined ? undefined : { type: "date", value };
    }
    case "page":
      return typeof wire.value === "string" && related.has(wire.value)
        ? {
            type: "page",
            value: wire.value,
            ...(typeof wire.dataSourceId === "string" ? { dataSourceId: wire.dataSourceId } : {}),
          }
        : undefined;
    case "array": {
      if (!Array.isArray(wire.value)) return undefined;
      const items = wire.value.flatMap((item) => {
        const kept = sanitizeComputed(item, related);
        return kept === undefined ? [] : [kept];
      });
      return {
        type: "array",
        value: items,
        ...(typeof wire.truncated === "boolean" ? { truncated: wire.truncated } : {}),
      };
    }
    default:
      return undefined;
  }
};

const sanitizeCell = (
  property: Property,
  value: Json,
  related: ReadonlySet<string>,
): Json | undefined => {
  switch (property.type) {
    case "text":
      return sanitizeRuns(value);
    case "relation": {
      if (!Array.isArray(value)) return undefined;
      const ids = value.filter((id): id is string => typeof id === "string" && related.has(id));
      return ids.length === 0 ? undefined : ids;
    }
    case "files": {
      if (!Array.isArray(value)) return undefined;
      return value.flatMap((item): Json[] =>
        isObject(item) &&
        typeof item.url === "string" &&
        /^https?:\/\//i.test(item.url) &&
        typeof item.name === "string"
          ? [{ name: item.name, url: item.url }]
          : [],
      );
    }
    case "formula":
    case "rollup":
      return sanitizeComputed(value, related);
    default:
      return value;
  }
};

const keep = (source: JsonObject, keys: readonly string[]): JsonObject => {
  const out: Record<string, Json> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const sanitizeConfig = (property: Property): JsonObject => {
  const { config } = property;
  switch (property.type) {
    case "number":
      return keep(config, ["format", "decimals", "showAs"]);
    case "select":
    case "multi_select":
    case "status":
      return { options: [] };
    case "date":
    case "created_time":
    case "last_edited_time":
      return keep(config, ["dateFormat", "timeFormat"]);
    case "unique_id":
      return keep(config, ["prefix"]);
    case "relation":
      return keep(config, ["dataSourceId", "limit"]);
    case "rollup":
      return keep(config, [
        "relationPropertyId",
        "targetPropertyId",
        "function",
        "format",
        "decimals",
      ]);
    case "formula":
      return { expression: "", ...keep(config, ["format", "decimals"]) };
    default:
      return {};
  }
};

export const sanitizeProperty = (property: Property): C.SpaceDatabaseProperty => {
  const computed = property.computed;
  const queryType = queryTypeOf(computed);
  const info =
    (property.type === "formula" || property.type === "rollup") && computed !== null
      ? {
          computed: {
            resultType: computed.type as Json,
            ...(queryType === undefined ? {} : { queryType }),
          },
        }
      : {};
  return {
    id: C.SpacePropertyId.make(property.id),
    name: property.name,
    type: property.type,
    config: sanitizeConfig(property),
    position: property.position,
    ...info,
  };
};

/** Rebuilt from an allow-list: only keys without free content survive, never rest keys. */
const orderKey = (value: unknown): C.SpaceGroupKey | null => {
  if (!isObject(value)) return null;
  switch (value.kind) {
    case "empty":
      return { kind: "empty" };
    case "option":
      return typeof value.optionId === "string"
        ? { kind: "option", optionId: C.SpaceOptionId.make(value.optionId) }
        : null;
    case "status_group":
      return value.group === "todo" || value.group === "in_progress" || value.group === "complete"
        ? { kind: "status_group", group: value.group }
        : null;
    case "checkbox":
      return typeof value.value === "boolean" ? { kind: "checkbox", value: value.value } : null;
    default:
      return null;
  }
};

const GROUP_BY = new Set([
  "option",
  "status_group",
  "checkbox",
  "exact",
  "alphabetical",
  "page",
  "day",
  "week",
  "month",
  "year",
  "relative",
]);

const groupBy = (by: unknown): Json | undefined => {
  if (typeof by === "string") return GROUP_BY.has(by) ? by : undefined;
  if (!isObject(by) || !isObject(by.range)) return undefined;
  const { start, size } = by.range;
  return typeof start === "number" && typeof size === "number"
    ? { range: { start, size } }
    : undefined;
};

const groupOrder = (scope: ViewScope, order: ReadonlyArray<unknown>) => {
  const hidden = new Set((scope.shape.group?.hidden ?? []).map((key) => canonical(key)));
  return order.flatMap((value) => {
    const key = orderKey(value);
    return key === null || hidden.has(canonical(key)) ? [] : [key];
  });
};

const sanitizeLayout = (scope: ViewScope, shown: ReadonlySet<string>): JsonObject => {
  const layout = scope.shape.layout;
  const out: Record<string, Json> = {};
  const flag = (key: string) => {
    const value = layout[key];
    if (typeof value === "boolean") out[key] = value;
  };
  const word = (key: string) => {
    const value = layout[key];
    if (typeof value === "string") out[key] = value;
  };
  const property = (key: string) => {
    const value = layout[key];
    if (typeof value === "string" && shown.has(value)) out[key] = value;
  };
  const preview = () => {
    const value = layout.cardPreview;
    if (!isObject(value)) return;
    if (value.kind === "none" || value.kind === "page_cover" || value.kind === "page_content")
      out.cardPreview = { kind: value.kind };
    else if (
      value.kind === "property" &&
      typeof value.propertyId === "string" &&
      shown.has(value.propertyId)
    )
      out.cardPreview = { kind: "property", propertyId: value.propertyId };
  };
  switch (scope.shape.type) {
    case "chart": {
      word("chartType");
      flag("colorByOption");
      word("sortByValue");
      flag("showValues");
      const y = layout.y;
      if (
        isObject(y) &&
        typeof y.property === "string" &&
        shown.has(y.property) &&
        typeof y.function === "string" &&
        (C.SPACE_CHART_Y_FUNCTIONS as ReadonlyArray<string>).includes(y.function)
      )
        out.y = { property: y.property, function: y.function };
      break;
    }
    case "feed":
      if (typeof layout.previewBlocks === "number") out.previewBlocks = layout.previewBlocks;
      break;
    case "form":
      word("description");
      break;
    case "table":
      flag("wrapCells");
      break;
    case "board":
      word("cardSize");
      preview();
      flag("fitImage");
      flag("colorColumns");
      break;
    case "list":
      flag("showPropertyNames");
      break;
    case "gallery":
      word("cardSize");
      preview();
      flag("fitImage");
      break;
    case "calendar":
      property("datePropertyId");
      word("weekStart");
      break;
    case "timeline":
      property("startPropertyId");
      property("endPropertyId");
      break;
  }
  return out;
};

export const shownProperties = (scope: Pick<ViewScope, "exposed">): ReadonlySet<string> =>
  new Set([...scope.exposed.columns.map((column) => column.propertyId), ...scope.exposed.extras]);

export const sanitizeView = (scope: ViewScope): SpaceSharedDatabaseView => {
  const shown = shownProperties(scope);
  const { group, type } = scope.shape;
  const by = group === null ? undefined : groupBy(group.by);
  const grouped = group !== null && type !== "calendar" && type !== "timeline" && type !== "feed";
  return {
    id: scope.view.view_id,
    dataSourceId: scope.view.data_source_id,
    name: scope.view.name,
    type,
    properties: scope.exposed.columns
      .filter((column) => column.propertyId !== C.SPACE_TITLE_PROPERTY_ID)
      .map((column) => ({
        propertyId: C.SpacePropertyId.make(column.propertyId),
        ...(column.width === undefined ? {} : { width: column.width }),
        ...(column.wrap === undefined ? {} : { wrap: column.wrap }),
      })),
    layout: sanitizeLayout(scope, shown),
    ...(grouped
      ? {
          group: {
            property: C.SpacePropertyId.make(group.property),
            ...(by === undefined ? {} : { by }),
            ...(typeof group.sort === "string" ? { sort: group.sort } : {}),
            ...(Array.isArray(group.order) ? { order: groupOrder(scope, group.order) } : {}),
            ...(typeof group.hideEmpty === "boolean" ? { hideEmpty: group.hideEmpty } : {}),
          },
        }
      : {}),
  };
};

/** Related pages inside the shared tree, reduced to what a link may show. */
export const sanitizeRelated = (
  scope: ViewScope,
  related: Readonly<Record<string, C.SpaceRelatedPage>>,
) => {
  const out: Record<string, C.SpaceRelatedPage> = {};
  for (const [id, page] of Object.entries(related)) {
    if (!scope.inTree(page.dataSourceId)) continue;
    out[id] = {
      title: page.title,
      ...(page.icon === undefined ? {} : { icon: page.icon }),
      dataSourceId: page.dataSourceId,
    };
  }
  return out;
};

/** Collects the option ids that the returned rows and bucket keys actually use. */
export interface OptionLedger {
  noteCell(property: Property, value: Json): void;
  noteKey(key: C.SpaceGroupKey): void;
  build(): Record<
    string,
    Array<{ id: C.SpaceOptionId; name: string; color: string; group?: string }>
  >;
}

export const optionLedger = (scope: ViewScope): OptionLedger => {
  const used = new Map<string, Set<string>>();
  const note = (propertyId: string, optionId: string) => {
    const ids = used.get(propertyId) ?? new Set<string>();
    ids.add(optionId);
    used.set(propertyId, ids);
  };
  return {
    noteCell(property, value) {
      if (property.type === "select" || property.type === "status") {
        if (typeof value === "string") note(property.id, value);
      } else if (property.type === "multi_select" && Array.isArray(value)) {
        for (const id of value) if (typeof id === "string") note(property.id, id);
      }
    },
    noteKey(key) {
      const group = scope.shape.group;
      if (group !== null && key.kind === "option" && typeof key.optionId === "string")
        note(group.property, key.optionId);
    },
    build() {
      const out: ReturnType<OptionLedger["build"]> = {};
      for (const [propertyId, ids] of used) {
        const property = scope.snapshot.byId.get(propertyId);
        if (property === undefined) continue;
        const found = property.options.filter((option) => ids.has(option.option_id));
        if (found.length === 0) continue;
        out[propertyId] = found.map((option) => ({
          id: C.SpaceOptionId.make(option.option_id),
          name: option.name,
          color: option.color,
          ...(property.type === "status" && option.status_group !== null
            ? { group: option.status_group }
            : {}),
        }));
      }
      return out;
    },
  };
};

export const sanitizeRow = (
  scope: Pick<ViewScope, "exposed" | "snapshot">,
  row: C.SpaceDatabaseRow,
  related: ReadonlySet<string>,
  ledger: OptionLedger,
): SpaceSharedDatabaseRow => {
  const shown = shownProperties(scope);
  const cells: Record<string, Json> = {};
  for (const id of shown) {
    if (id === C.SPACE_TITLE_PROPERTY_ID) continue;
    const property = scope.snapshot.byId.get(id);
    const value = row.cells[id];
    if (property === undefined || value === undefined) continue;
    const clean = sanitizeCell(property, value, related);
    if (clean === undefined) continue;
    ledger.noteCell(property, clean);
    cells[id] = clean;
  }
  const assetId = row.cover?.assetId;
  return {
    id: row.page.id,
    title: row.page.title,
    ...(row.page.icon === undefined ? {} : { icon: row.page.icon }),
    cells,
    ...(assetId === undefined ? {} : { cover: { assetId } }),
  };
};

const chartAggregate = (scope: ViewScope) => {
  const y = scope.shape.layout.y;
  return scope.shape.type === "chart" &&
    isObject(y) &&
    typeof y.property === "string" &&
    typeof y.function === "string" &&
    shownProperties(scope).has(y.property)
    ? { property: C.SpacePropertyId.make(y.property), function: y.function }
    : undefined;
};

/** A chart bucket keeps only the y aggregate. */
const bucketAggregates = (
  results: ReadonlyArray<C.SpaceAggregateResult> | undefined,
  y: { readonly property: C.SpacePropertyId; readonly function: string },
) => {
  const found = results?.find(
    (result) => result.property === y.property && result.function === y.function,
  );
  return [
    {
      property: y.property,
      function: y.function,
      ...(found?.number === undefined ? {} : { number: found.number }),
    },
  ];
};

/** One window of query results as a link may see it. Cursors stay raw; the service seals them. */
export const sanitizeWindow = (scope: ViewScope, result: C.SpaceDatabaseQueryResult) => {
  const relatedPages = sanitizeRelated(scope, result.relatedPages);
  const related = new Set(Object.keys(relatedPages));
  const ledger = optionLedger(scope);
  const rows = result.rows.map((row) => sanitizeRow(scope, row, related, ledger));
  const hidden = new Set((scope.shape.group?.hidden ?? []).map((key) => canonical(key)));
  const aggregate = chartAggregate(scope);
  const groups = result.groups
    ?.filter((bucket) => bucket.count > 0 && !hidden.has(canonical(bucket.key)))
    .map((bucket) => {
      ledger.noteKey(bucket.key);
      return {
        key: bucket.key,
        ...(bucket.label === undefined ? {} : { label: bucket.label }),
        count: bucket.count,
        rows: bucket.rows.map((row) => sanitizeRow(scope, row, related, ledger)),
        nextCursor: bucket.nextCursor,
        ...(aggregate === undefined
          ? {}
          : { aggregates: bucketAggregates(bucket.aggregates, aggregate) }),
      };
    });
  return {
    rows,
    ...(groups === undefined ? {} : { groups }),
    ...(result.groupsTruncated === true ? { groupsTruncated: true } : {}),
    relatedPages,
    options: ledger.build(),
    nextCursor: result.nextCursor,
  };
};
