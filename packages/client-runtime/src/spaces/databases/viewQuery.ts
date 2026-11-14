import type { EnvironmentId } from "@t2code/contracts";
import {
  SpacePropertyId,
  type SpaceAggregate,
  type SpaceDataSource,
  type SpaceDatabaseQueryInput,
  type SpaceDatabaseView,
  type SpaceFilter,
  type SpaceGroup,
  type SpaceGroupKey,
  type SpacePageId,
} from "@t2code/contracts/spaces";

import { computedInputs } from "./computed.ts";
import { viewTraits } from "./viewTraits.ts";

export interface ViewQueryOptions {
  readonly environmentId: EnvironmentId;
  readonly mode: "rows" | "groups";
  readonly timeZone: string;
  readonly limit: number;
  readonly rowsPerGroup?: number;
  readonly search?: string;
  readonly visiblePropertyIds: ReadonlyArray<SpacePropertyId>;
  readonly includeAggregates: boolean;
  /** ANDed with the view's filter by the server: a calendar's visible range. */
  readonly extraFilter?: SpaceFilter;
  /** Cells to return even when the view hides the property (the date a calendar places rows by). */
  readonly extraPropertyIds?: ReadonlyArray<SpacePropertyId>;
  /** Sub-items: null is the top level, an id is that row's children. */
  readonly scope?: { readonly parentRowId: SpacePageId | null };
  /** Ask for each row's first body image (`row.cover`), for cards with a page-content preview. */
  readonly cover?: boolean;
  /** Present replaces the view's column aggregates: a chart's y. */
  readonly aggregates?: ReadonlyArray<SpaceAggregate>;
  /** Rows mode: one group bucket's rows, with the view's grouping kept. */
  readonly bucket?: SpaceGroupKey;
  /** Rows mode: the first N body blocks of each row, for feed cards. */
  readonly preview?: number;
}

/** Caps a window and a board's rows per group at the view's chosen load limit; other types ignore it. */
export function applyLoadLimit(
  view: SpaceDatabaseView,
  sizes: { readonly limit: number; readonly rowsPerGroup?: number },
): { readonly limit: number; readonly rowsPerGroup?: number } {
  const loadLimit: unknown = (view.layout as { loadLimit?: unknown }).loadLimit;
  if (
    !viewTraits(view.type).loadLimit ||
    (loadLimit !== 10 && loadLimit !== 25 && loadLimit !== 50 && loadLimit !== 100)
  )
    return sizes;
  return {
    limit: Math.min(sizes.limit, loadLimit),
    ...(sizes.rowsPerGroup === undefined
      ? {}
      : { rowsPerGroup: Math.min(sizes.rowsPerGroup, loadLimit) }),
  };
}

/** Presentation fields never reach the query, so toggling one is not a new query. */
function queryGroup(group: SpaceGroup | undefined): SpaceGroup | null {
  if (group === undefined) return null;
  const { hideEmpty: _h, order: _o, hidden: _hidden, collapsed: _c, ...rest } = group;
  return rest;
}

/**
 * The explicit query of a view. No `viewId` is sent, so an unsaved view edit changes the key and
 * restarts the query. `include` is left to the session, which asks for totals on the first window.
 */
export function viewQueryInput(
  view: SpaceDatabaseView,
  options: ViewQueryOptions,
): SpaceDatabaseQueryInput {
  const aggregates: ReadonlyArray<SpaceAggregate> =
    options.aggregates ??
    (options.includeAggregates
      ? view.properties.flatMap((entry) =>
          entry.aggregate === undefined
            ? []
            : [{ property: entry.propertyId, function: entry.aggregate }],
        )
      : []);
  const rows = options.mode === "rows";
  const include = {
    ...(options.cover === true ? { cover: true } : {}),
    ...(rows && options.preview !== undefined ? { preview: options.preview } : {}),
  };
  const scope =
    rows && options.bucket !== undefined
      ? { ...options.scope, group: options.bucket }
      : options.scope;
  return {
    environmentId: options.environmentId,
    dataSourceId: view.dataSourceId,
    filter: view.filter ?? null,
    sorts: view.sorts,
    group: !rows || options.bucket !== undefined ? queryGroup(view.group) : null,
    subGroup: rows || view.type === "chart" ? null : queryGroup(view.subGroup),
    ...(options.search === undefined || options.search === "" ? {} : { search: options.search }),
    mode: options.mode,
    ...(options.extraFilter === undefined ? {} : { extraFilter: options.extraFilter }),
    ...(scope === undefined ? {} : { scope }),
    ...(Object.keys(include).length === 0 ? {} : { include }),
    properties: [
      ...new Set([...options.visiblePropertyIds, ...(options.extraPropertyIds ?? [])]),
    ].sort(),
    aggregates,
    ...(options.mode === "groups" && options.rowsPerGroup !== undefined
      ? { rowsPerGroup: options.rowsPerGroup }
      : {}),
    limit: options.limit,
    timeZone: options.timeZone,
  };
}

function filterProperties(filter: SpaceFilter | undefined, into: Set<SpacePropertyId>) {
  if (filter === undefined) return;
  if ("and" in filter) for (const child of filter.and) filterProperties(child, into);
  else if ("or" in filter) for (const child of filter.or) filterProperties(child, into);
  else into.add(filter.property);
}

/** Every property whose edit can change which rows, in which order or buckets, or what an aggregate says. */
export function viewDependencies(
  view: SpaceDatabaseView,
  extraFilter?: SpaceFilter,
  dataSource?: SpaceDataSource,
  visiblePropertyIds: ReadonlyArray<SpacePropertyId> = [],
): ReadonlySet<SpacePropertyId> {
  const ids = new Set<SpacePropertyId>();
  filterProperties(view.filter, ids);
  filterProperties(extraFilter, ids);
  for (const sort of view.sorts) ids.add(sort.property);
  if (view.group) ids.add(view.group.property);
  if (view.subGroup) ids.add(view.subGroup.property);
  const y: unknown = (view.layout as { y?: unknown }).y;
  if (view.type === "chart" && typeof y === "object" && y !== null && "property" in y)
    if (typeof y.property === "string") ids.add(SpacePropertyId.make(y.property));
  for (const entry of view.properties) if (entry.aggregate !== undefined) ids.add(entry.propertyId);
  if (dataSource === undefined) return ids;
  // A computed value changes when any of its inputs does, even though the view never names them.
  for (const id of [...ids, ...visiblePropertyIds])
    for (const input of computedInputs(dataSource, id)) ids.add(input);
  return ids;
}
