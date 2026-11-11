import { Option, Schema } from "effect";
import {
  SPACE_TITLE_PROPERTY_ID,
  SpaceKnownDatabaseProperty,
  SpaceKnownDatabaseView,
  type SpaceComputedInfo,
  type SpaceDataSource,
  type SpaceDatabaseProperty,
  type SpaceDatabaseRow,
  type SpaceDatabaseView,
  type SpaceStatusGroup,
  type SpaceViewId,
} from "@t2code/contracts/spaces";

const decodeProperty = Schema.decodeUnknownOption(SpaceKnownDatabaseProperty, {
  onExcessProperty: "error",
});
const decodeView = Schema.decodeUnknownOption(SpaceKnownDatabaseView, {
  onExcessProperty: "error",
});
const propertyCache = new WeakMap<object, SpaceKnownDatabaseProperty | null>();
const computedInfo = new WeakMap<SpaceKnownDatabaseProperty, SpaceComputedInfo>();
const viewCache = new WeakMap<object, SpaceKnownDatabaseView | null>();

/** The property when its type and config are understood by this client. */
export function knownProperty(property: SpaceDatabaseProperty): SpaceKnownDatabaseProperty | null {
  const cached = propertyCache.get(property);
  if (cached !== undefined) return cached;
  // The known structs do not carry the server-derived `computed` envelope key.
  const { computed, ...own } = property;
  const decoded = Option.getOrNull(decodeProperty(own));
  if (decoded !== null && computed !== undefined) computedInfo.set(decoded, computed);
  propertyCache.set(property, decoded);
  return decoded;
}

/** What the server derived for a known formula or rollup: result type, query type, error. */
export function computedInfoOf(known: SpaceKnownDatabaseProperty): SpaceComputedInfo | undefined {
  return computedInfo.get(known);
}

export function knownView(view: SpaceDatabaseView): SpaceKnownDatabaseView | null {
  const cached = viewCache.get(view);
  if (cached !== undefined) return cached;
  const decoded = Option.getOrNull(decodeView(view));
  viewCache.set(view, decoded);
  return decoded;
}

export interface ViewColumn {
  readonly property: SpaceDatabaseProperty;
  readonly known: SpaceKnownDatabaseProperty | null;
  readonly visible: boolean;
  readonly width: number | undefined;
  readonly aggregate: string | undefined;
  readonly wrap: boolean | undefined;
}

/**
 * Columns in view order: the view's property list first (ids that are not live are skipped), then
 * live properties missing from it, hidden, by schema position. The title is always visible.
 */
export function viewColumns(
  view: SpaceDatabaseView,
  dataSource: SpaceDataSource,
): ReadonlyArray<ViewColumn> {
  const columns: ViewColumn[] = [];
  const seen = new Set<string>();
  const column = (
    property: SpaceDatabaseProperty,
    entry: SpaceDatabaseView["properties"][number] | undefined,
  ): ViewColumn => ({
    property,
    known: knownProperty(property),
    visible: property.id === SPACE_TITLE_PROPERTY_ID || (entry?.visible ?? false),
    width: entry?.width,
    aggregate: entry?.aggregate,
    wrap: entry?.wrap,
  });
  for (const entry of view.properties) {
    const property = dataSource.properties[entry.propertyId];
    if (property === undefined || seen.has(property.id)) continue;
    seen.add(property.id);
    columns.push(column(property, entry));
  }
  const rest = Object.values(dataSource.properties)
    .filter((property) => !seen.has(property.id))
    .sort((a, b) => a.position - b.position);
  for (const property of rest) columns.push(column(property, undefined));
  return columns;
}

export interface PropertyOption {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly group?: SpaceStatusGroup;
}

export function propertyOptions(
  known: SpaceKnownDatabaseProperty | null,
): ReadonlyArray<PropertyOption> {
  if (known === null) return [];
  if (known.type === "select" || known.type === "multi_select" || known.type === "status")
    return known.config.options;
  return [];
}

/** The title cell as text. Never the page title: a pending edit patches the cell only. */
export function rowTitle(row: SpaceDatabaseRow): string {
  const value = row.cells[SPACE_TITLE_PROPERTY_ID];
  return typeof value === "string" ? value : "";
}

/** The views of one database named by a block, in block order; missing ids are skipped. */
export function resolveBlockViews(
  viewIds: ReadonlyArray<SpaceViewId>,
  views: ReadonlyArray<SpaceDatabaseView>,
): ReadonlyArray<SpaceDatabaseView> {
  const byId = new Map(views.map((view) => [view.id, view]));
  return viewIds.flatMap((id) => {
    const view = byId.get(id);
    return view === undefined ? [] : [view];
  });
}
