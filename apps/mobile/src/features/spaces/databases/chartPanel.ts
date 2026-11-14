import {
  chartAggregates,
  chartConfig,
  knownProperty,
  knownView,
  viewQueryInput,
  type ChartConfig,
} from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceDataSource,
  SpaceDatabaseQueryInput,
  SpaceDatabaseView,
  SpaceKnownDatabaseProperty,
  SpaceKnownGroup,
} from "@t2code/contracts/spaces";

export const PICK_X_AXIS_MESSAGE = "Pick an X axis for this chart on desktop.";

export interface ChartSetup {
  readonly config: ChartConfig;
  readonly group: SpaceKnownGroup;
  readonly groupProperty: SpaceKnownDatabaseProperty | null;
  readonly propertyName: string;
  readonly yName: string | null;
}

/** The chart a saved view describes, or null when it is not a chart or has no X axis. */
export function chartSetup(
  view: SpaceDatabaseView,
  dataSource: SpaceDataSource,
): ChartSetup | null {
  const known = knownView(view);
  if (known === null || known.type !== "chart" || known.group === undefined) return null;
  const config = chartConfig(known);
  const raw = dataSource.properties[known.group.property];
  const yRaw = config.y === null ? undefined : dataSource.properties[config.y.property];
  return {
    config,
    group: known.group,
    groupProperty: raw === undefined ? null : knownProperty(raw),
    propertyName: raw?.name ?? "Property",
    yName: yRaw?.name ?? null,
  };
}

/** One bounded grouped query: buckets with the y aggregate, no rows. Null without an X axis. */
export function chartQueryInput(
  view: SpaceDatabaseView,
  dataSource: SpaceDataSource,
  options: { readonly environmentId: EnvironmentId; readonly timeZone: string },
): SpaceDatabaseQueryInput | null {
  const setup = chartSetup(view, dataSource);
  if (setup === null) return null;
  return viewQueryInput(view, {
    environmentId: options.environmentId,
    mode: "groups",
    timeZone: options.timeZone,
    limit: 1,
    rowsPerGroup: 0,
    visiblePropertyIds: [],
    includeAggregates: true,
    aggregates: chartAggregates(setup.config),
  });
}

/** A value as the accessible list and value labels print it. */
export function chartValueText(value: number | null): string {
  if (value === null) return "No value";
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
