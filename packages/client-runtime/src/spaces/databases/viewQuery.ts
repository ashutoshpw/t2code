import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceAggregate,
  SpaceDatabaseQueryInput,
  SpaceDatabaseView,
  SpaceFilter,
  SpacePropertyId,
} from "@t2code/contracts/spaces";

export interface ViewQueryOptions {
  readonly environmentId: EnvironmentId;
  readonly mode: "rows" | "groups";
  readonly timeZone: string;
  readonly limit: number;
  readonly rowsPerGroup?: number;
  readonly search?: string;
  readonly visiblePropertyIds: ReadonlyArray<SpacePropertyId>;
  readonly includeAggregates: boolean;
}

/**
 * The explicit query of a view. No `viewId` is sent, so an unsaved view edit changes the key and
 * restarts the query. `include` is left to the session, which asks for totals on the first window.
 */
export function viewQueryInput(
  view: SpaceDatabaseView,
  options: ViewQueryOptions,
): SpaceDatabaseQueryInput {
  const aggregates: SpaceAggregate[] = options.includeAggregates
    ? view.properties.flatMap((entry) =>
        entry.aggregate === undefined
          ? []
          : [{ property: entry.propertyId, function: entry.aggregate }],
      )
    : [];
  return {
    environmentId: options.environmentId,
    dataSourceId: view.dataSourceId,
    filter: view.filter ?? null,
    sorts: view.sorts,
    group: options.mode === "rows" ? null : (view.group ?? null),
    subGroup: options.mode === "rows" ? null : (view.subGroup ?? null),
    ...(options.search === undefined || options.search === "" ? {} : { search: options.search }),
    mode: options.mode,
    properties: [...options.visiblePropertyIds].sort(),
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
export function viewDependencies(view: SpaceDatabaseView): ReadonlySet<SpacePropertyId> {
  const ids = new Set<SpacePropertyId>();
  filterProperties(view.filter, ids);
  for (const sort of view.sorts) ids.add(sort.property);
  if (view.group) ids.add(view.group.property);
  if (view.subGroup) ids.add(view.subGroup.property);
  for (const entry of view.properties) if (entry.aggregate !== undefined) ids.add(entry.propertyId);
  return ids;
}
