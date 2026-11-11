import {
  canonicalJson,
  groupLabel,
  orderBuckets,
  propertyQueryType,
  rangeOverlapFilter,
  viewColumns,
  viewQueryInput,
  type GroupLabel,
  type OptionHint,
  type ViewColumn,
} from "@t2code/client-runtime/spaces";
import {
  SPACE_TITLE_PROPERTY_ID,
  SpacePropertyId,
  type SpaceDataSource,
} from "@t2code/contracts/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceDatabaseQueryInput,
  SpaceDatabaseRow,
  SpaceDatabaseView,
  SpaceGroup,
  SpaceGroupBucket,
  SpaceGroupKey,
} from "@t2code/contracts/spaces";

import { agendaSections, dayLabel, monthBounds, rangeLabel } from "./agenda";

/** Rows kept per view and per section before the phone stops offering more. */
export const MAX_VIEW_ROWS = 500;
export const MAX_SECTION_ROWS = 200;
export const BOARD_ROWS_PER_GROUP = 10;
const MAX_WINDOW = 50;
const DEFAULT_WINDOW = 25;
const AGENDA_WINDOW = 100;
/** The inline block draws this many rows (more on a full-page database). */
export const BLOCK_PREVIEW_ROWS = 10;
export const FULL_PAGE_PREVIEW_ROWS = 25;

export const DESKTOP_LIMIT_NOTE = "Open on desktop to see more rows.";
export const UNSUPPORTED_VIEW_MESSAGE = "This view type isn't supported in this version.";
export const PICK_DATE_MESSAGE = "Pick a date property for this view on desktop.";

export type ViewFormKind = "cards" | "compact" | "board" | "gallery" | "agenda" | "message";

export interface AgendaPlan {
  readonly start: { readonly id: SpacePropertyId; readonly type: string };
  readonly end: { readonly id: SpacePropertyId; readonly type: string } | null;
}

/** How one saved view is drawn on a phone. Nothing in it is configurable there. */
export interface ViewForm {
  readonly kind: ViewFormKind;
  readonly type: string;
  /** Null when no query runs (an unsupported view, a calendar with no date property). */
  readonly mode: "rows" | "groups" | null;
  readonly limit: number;
  readonly rowsPerGroup: number | undefined;
  readonly showPropertyNames: boolean;
  /** The columns cards draw after the title: only these are asked for. */
  readonly columns: ReadonlyArray<ViewColumn>;
  /** A gallery's preview property, drawn as the card's lead line. */
  readonly previewColumn: ViewColumn | null;
  readonly groupColumn: ViewColumn | null;
  readonly group: SpaceGroup | undefined;
  readonly agenda: AgendaPlan | null;
  /** Lines shown under the view switcher. */
  readonly notes: ReadonlyArray<string>;
  /** Replaces the body when the view cannot be drawn. */
  readonly message: string | null;
}

interface Layout {
  readonly loadLimit: number | undefined;
  readonly showPropertyNames: boolean;
  readonly previewKind: string | undefined;
  readonly previewPropertyId: string | undefined;
  readonly datePropertyId: string | undefined;
  readonly startPropertyId: string | undefined;
  readonly endPropertyId: string | undefined;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** The layout keys a phone reads, defensively: the layout is open JSON and may come from a newer server. */
function layoutOf(view: SpaceDatabaseView): Layout {
  const layout = record(view.layout);
  const preview = record(layout["cardPreview"]);
  return {
    loadLimit: typeof layout["loadLimit"] === "number" ? layout["loadLimit"] : undefined,
    showPropertyNames: layout["showPropertyNames"] === true,
    previewKind: text(preview["kind"]),
    previewPropertyId: text(preview["propertyId"]),
    datePropertyId: text(layout["datePropertyId"]),
    startPropertyId: text(layout["startPropertyId"]),
    endPropertyId: text(layout["endPropertyId"]),
  };
}

const DATE_TYPES = new Set(["date", "created_time", "last_edited_time"]);

function dateEnd(dataSource: SpaceDataSource, id: string | undefined) {
  const property = id === undefined ? undefined : dataSource.properties[id];
  if (property === undefined) return null;
  const type = propertyQueryType(property) ?? property.type;
  if (!DATE_TYPES.has(property.type) && type !== "date") return null;
  return { id: property.id, type };
}

const LINES: Record<string, number> = { table: 4, list: 2, board: 3, gallery: 3 };

const messageForm = (type: string, message: string): ViewForm => ({
  kind: "message",
  type,
  mode: null,
  limit: 0,
  rowsPerGroup: undefined,
  showPropertyNames: false,
  columns: [],
  previewColumn: null,
  groupColumn: null,
  group: undefined,
  agenda: null,
  notes: [],
  message,
});

/** Decides how a saved view is drawn on a phone, and which properties it needs. */
export function viewForm(
  view: SpaceDatabaseView,
  dataSource: SpaceDataSource,
  limits: { readonly maxQueryRows: number },
): ViewForm {
  const layout = layoutOf(view);
  const all = viewColumns(view, dataSource);
  const limit = Math.max(
    1,
    Math.min(layout.loadLimit ?? DEFAULT_WINDOW, MAX_WINDOW, limits.maxQueryRows),
  );
  const common = { type: view.type, showPropertyNames: layout.showPropertyNames, limit };
  if (view.type === "calendar" || view.type === "timeline") {
    const calendar = view.type === "calendar";
    const start = dateEnd(dataSource, calendar ? layout.datePropertyId : layout.startPropertyId);
    if (start === null) return messageForm(view.type, PICK_DATE_MESSAGE);
    const end = calendar ? null : dateEnd(dataSource, layout.endPropertyId);
    const own = end !== null && end.id !== start.id ? end : null;
    return {
      ...common,
      kind: "agenda",
      mode: "rows",
      limit: Math.min(AGENDA_WINDOW, limits.maxQueryRows),
      rowsPerGroup: undefined,
      columns: all
        .filter(
          (column) =>
            column.visible &&
            column.property.id !== SPACE_TITLE_PROPERTY_ID &&
            column.property.id !== start.id &&
            column.property.id !== own?.id,
        )
        .slice(0, 2),
      previewColumn: null,
      groupColumn: null,
      group: undefined,
      agenda: { start, end: own },
      notes: ["Rows without a date are listed on desktop."],
      message: null,
    };
  }
  const lines = LINES[view.type];
  if (lines === undefined) return messageForm(view.type, UNSUPPORTED_VIEW_MESSAGE);
  const groupColumn =
    view.group === undefined
      ? null
      : (all.find((column) => column.property.id === view.group?.property) ?? null);
  const grouped = groupColumn !== null;
  const board = view.type === "board";
  const gallery = view.type === "gallery";
  const previewColumn =
    gallery && layout.previewKind === "property"
      ? (all.find((column) => column.property.id === layout.previewPropertyId) ?? null)
      : null;
  const columns = all
    .filter(
      (column) =>
        column.visible &&
        column.property.id !== SPACE_TITLE_PROPERTY_ID &&
        column.property.id !== previewColumn?.property.id &&
        !(board && column.property.id === groupColumn?.property.id),
    )
    .slice(0, lines);
  return {
    ...common,
    kind:
      board && grouped ? "board" : gallery ? "gallery" : view.type === "list" ? "compact" : "cards",
    mode: grouped ? "groups" : "rows",
    rowsPerGroup: grouped ? BOARD_ROWS_PER_GROUP : undefined,
    columns,
    previewColumn,
    groupColumn,
    group: grouped ? view.group : undefined,
    agenda: null,
    notes:
      gallery && (layout.previewKind === "page_cover" || layout.previewKind === "page_content")
        ? ["Cover images are shown on desktop."]
        : [],
    message: null,
  };
}

/** The line under the view switcher: what the saved view does that this screen cannot change. */
export function viewSummary(view: SpaceDatabaseView, dataSource: SpaceDataSource): string {
  const parts: string[] = [];
  if (view.filter !== undefined) parts.push("Filtered");
  if (view.sorts.length > 0) parts.push("Sorted");
  if (view.group !== undefined)
    parts.push(`Grouped by ${dataSource.properties[view.group.property]?.name ?? "a property"}`);
  return parts.length === 0
    ? "Change filters, sorting and layout on desktop."
    : `${parts.join(" · ")}. Change views on desktop.`;
}

export interface FormQueryOptions {
  readonly environmentId: EnvironmentId;
  readonly timeZone: string;
  /** `YYYY-MM-01` of the month an agenda shows. */
  readonly month?: string;
}

/** The properties a form's cards draw, title first; never the whole schema. */
export function formPropertyIds(form: ViewForm): ReadonlyArray<SpacePropertyId> {
  return [
    SpacePropertyId.make(SPACE_TITLE_PROPERTY_ID),
    ...(form.previewColumn === null ? [] : [form.previewColumn.property.id]),
    ...form.columns.map((column) => column.property.id),
  ];
}

/**
 * The query a form runs: the view's saved filter, sorts and group go as they are saved, so what was
 * configured on desktop applies. Sub-groups are dropped (rows live in the sub-buckets, which a phone
 * does not draw). Null when the form runs no query.
 */
export function formQueryInput(
  form: ViewForm,
  view: SpaceDatabaseView,
  options: FormQueryOptions,
): SpaceDatabaseQueryInput | null {
  if (form.mode === null) return null;
  const agenda = form.agenda;
  const bounds = agenda === null || options.month === undefined ? null : monthBounds(options.month);
  const input = viewQueryInput(view, {
    environmentId: options.environmentId,
    mode: form.mode,
    timeZone: options.timeZone,
    limit: form.limit,
    ...(form.rowsPerGroup === undefined ? {} : { rowsPerGroup: form.rowsPerGroup }),
    visiblePropertyIds: formPropertyIds(form),
    includeAggregates: false,
    extraPropertyIds: [
      ...(form.groupColumn === null ? [] : [form.groupColumn.property.id]),
      ...(agenda === null
        ? []
        : [agenda.start.id, ...(agenda.end === null ? [] : [agenda.end.id])]),
    ],
    ...(agenda === null || bounds === null
      ? {}
      : {
          extraFilter: rangeOverlapFilter(
            agenda.start,
            agenda.end ?? undefined,
            bounds.firstDay,
            bounds.lastDay,
          ),
        }),
  });
  return { ...input, subGroup: null };
}

export type ListItem =
  | {
      readonly kind: "header";
      readonly key: string;
      readonly label: GroupLabel;
      readonly count: number | null;
    }
  | {
      readonly kind: "row";
      readonly key: string;
      readonly row: SpaceDatabaseRow;
      /** An agenda item that spans days: "Nov 9 → Nov 12". */
      readonly span: string | null;
    }
  | {
      readonly kind: "more";
      readonly key: string;
      readonly text: string;
      readonly bucket: SpaceGroupKey | null;
      readonly loading: boolean;
    }
  | { readonly kind: "note"; readonly key: string; readonly text: string };

export interface ListSource {
  readonly dataSourceId: string;
  readonly rows: ReadonlyArray<SpaceDatabaseRow>;
  readonly groups: ReadonlyArray<SpaceGroupBucket> | null;
  /** Rows mode: another window can be loaded. */
  readonly hasMore: boolean;
  readonly loadingMore?: boolean;
  readonly bucketLoading?: (key: SpaceGroupKey) => boolean;
  readonly optionHint: OptionHint;
  readonly zone: string;
  readonly month?: string;
}

const rowKey = (dataSourceId: string, row: SpaceDatabaseRow, prefix = "") =>
  `${prefix}${dataSourceId}:${row.page.id}`;

/** Whether another window may be asked for: the phone keeps at most `MAX_VIEW_ROWS` rows per view. */
export const canLoadMore = (loaded: number, hasMore: boolean) => hasMore && loaded < MAX_VIEW_ROWS;

/**
 * Flat list items for a form, with stable keys. Sections follow the saved group's order and hidden
 * groups; a board keeps its empty columns, other forms drop empty sections.
 */
export function listItems(form: ViewForm, source: ListSource): ReadonlyArray<ListItem> {
  if (form.kind === "message" || form.mode === null) return [];
  if (form.kind === "agenda") return agendaItems(form, source);
  if (form.mode === "groups") return groupItems(form, source);
  const items: ListItem[] = source.rows.map((row) => ({
    kind: "row",
    key: rowKey(source.dataSourceId, row),
    row,
    span: null,
  }));
  if (source.hasMore && source.rows.length >= MAX_VIEW_ROWS)
    items.push({ kind: "note", key: "note:desktop", text: DESKTOP_LIMIT_NOTE });
  return items;
}

function groupItems(form: ViewForm, source: ListSource): ReadonlyArray<ListItem> {
  const { shown } = orderBuckets(source.groups ?? [], form.group);
  const known = form.groupColumn?.known ?? null;
  const name = form.groupColumn?.property.name ?? "value";
  const items: ListItem[] = [];
  for (const bucket of shown) {
    if (form.kind !== "board" && bucket.count === 0) continue;
    const id = canonicalJson(bucket.key);
    items.push({
      kind: "header",
      key: `header:${id}`,
      label: groupLabel(bucket, known, name, source.optionHint),
      count: bucket.count,
    });
    for (const row of bucket.rows)
      items.push({ kind: "row", key: rowKey(source.dataSourceId, row, `${id}:`), row, span: null });
    if (bucket.nextCursor !== null)
      items.push(
        bucket.rows.length >= MAX_SECTION_ROWS
          ? { kind: "note", key: `note:${id}`, text: DESKTOP_LIMIT_NOTE }
          : {
              kind: "more",
              key: `more:${id}`,
              text: `Show more in ${groupLabel(bucket, known, name, source.optionHint).text}`,
              bucket: bucket.key,
              loading: source.bucketLoading?.(bucket.key) === true,
            },
      );
  }
  return items;
}

function agendaItems(form: ViewForm, source: ListSource): ReadonlyArray<ListItem> {
  const plan = form.agenda;
  if (plan === null || source.month === undefined) return [];
  const items: ListItem[] = [];
  for (const section of agendaSections(
    source.rows,
    plan.start.id,
    plan.end?.id ?? null,
    source.month,
    source.zone,
  )) {
    items.push({
      kind: "header",
      key: `day:${section.day}`,
      label: { text: dayLabel(section.day) },
      count: section.items.length,
    });
    for (const item of section.items)
      items.push({
        kind: "row",
        key: rowKey(source.dataSourceId, item.row, `${section.day}:`),
        row: item.row,
        span: rangeLabel(item),
      });
  }
  if (source.hasMore && source.rows.length >= MAX_VIEW_ROWS)
    items.push({ kind: "note", key: "note:desktop", text: DESKTOP_LIMIT_NOTE });
  else if (source.hasMore)
    items.push({
      kind: "more",
      key: "more:agenda",
      text: "Show more",
      bucket: null,
      loading: source.loadingMore === true,
    });
  return items;
}

/** The first `max` rows with the headers that lead them, for the bounded preview inside a page. */
export function previewItems(items: ReadonlyArray<ListItem>, max: number): ReadonlyArray<ListItem> {
  const out: ListItem[] = [];
  let rows = 0;
  for (const item of items) {
    if (item.kind === "row") {
      if (rows >= max) break;
      rows++;
    } else if (item.kind === "more" || item.kind === "note") {
      continue;
    }
    out.push(item);
  }
  while (out.length > 0 && out[out.length - 1]?.kind === "header") out.pop();
  return out;
}
