import {
  SPACE_CHART_MAX_BARS,
  type SPACE_CHART_TYPES,
  type SPACE_CHART_Y_FUNCTIONS,
  type SpaceAggregate,
  type SpaceGroupBucket,
  type SpaceGroupKey,
  type SpaceKnownDatabaseProperty,
  type SpaceKnownDatabaseView,
  type SpaceKnownGroup,
  type SpacePropertyId,
} from "@t2code/contracts/spaces";

import type { OptionHint } from "./format.ts";
import { groupLabel } from "./groupLabel.ts";
import { canonicalJson } from "./queryKey.ts";
import { orderBuckets } from "./regroup.ts";

export type ChartKind = (typeof SPACE_CHART_TYPES)[number];

export interface ChartConfig {
  readonly kind: ChartKind;
  readonly y: {
    readonly property: SpacePropertyId;
    readonly function: (typeof SPACE_CHART_Y_FUNCTIONS)[number];
  } | null;
  readonly colorByOption: boolean;
  readonly sortByValue: "ascending" | "descending" | null;
  readonly showValues: boolean;
}

export function chartConfig(
  known: Extract<SpaceKnownDatabaseView, { type: "chart" }>,
): ChartConfig {
  const { layout } = known;
  return {
    kind: layout.chartType ?? "bar",
    y: layout.y ?? null,
    colorByOption: layout.colorByOption ?? true,
    sortByValue: layout.sortByValue ?? null,
    showValues: layout.showValues ?? false,
  };
}

/** The aggregate the chart query adds: the y function over the y property, or none for counts. */
export function chartAggregates(config: ChartConfig): ReadonlyArray<SpaceAggregate> {
  return config.y === null ? [] : [{ property: config.y.property, function: config.y.function }];
}

export interface ChartDatum {
  /** `canonicalJson` of the group key. */
  readonly id: string;
  readonly key: SpaceGroupKey;
  readonly label: string;
  /** An option colour name when colouring by option and the key is an option or status group. */
  readonly color: string | null;
  readonly count: number;
  /** The count when y is null, else the bucket's aggregate; null is no value. */
  readonly value: number | null;
}

const valueOf = (bucket: SpaceGroupBucket, config: ChartConfig): number | null => {
  if (config.y === null) return bucket.count;
  const found = bucket.aggregates?.find(
    (entry) => entry.property === config.y?.property && entry.function === config.y.function,
  );
  return found?.number ?? null;
};

export function chartData(input: {
  readonly groups: ReadonlyArray<SpaceGroupBucket>;
  readonly config: ChartConfig;
  readonly group: SpaceKnownGroup;
  readonly groupProperty: SpaceKnownDatabaseProperty | null;
  readonly propertyName: string;
  readonly optionHint: OptionHint;
}): { readonly data: ReadonlyArray<ChartDatum>; readonly omitted: number } {
  const { config, group } = input;
  const ordered = orderBuckets(input.groups, group).shown;
  const all = ordered.map((bucket): ChartDatum => {
    const label = groupLabel(bucket, input.groupProperty, input.propertyName, input.optionHint);
    const colored =
      config.colorByOption &&
      (bucket.key.kind === "option" || bucket.key.kind === "status_group") &&
      label.color !== undefined;
    return {
      id: canonicalJson(bucket.key),
      key: bucket.key,
      label: label.text,
      color: colored ? (label.color ?? null) : null,
      count: bucket.count,
      value: valueOf(bucket, config),
    };
  });
  const direction = config.sortByValue === "ascending" ? 1 : -1;
  const sorted =
    config.sortByValue === null
      ? all
      : all
          .map((datum, index) => ({ datum, index }))
          .sort((a, b) => {
            if (a.datum.value === null || b.datum.value === null)
              return (
                Number(a.datum.value === null) - Number(b.datum.value === null) || a.index - b.index
              );
            return (a.datum.value - b.datum.value) * direction || a.index - b.index;
          })
          .map((entry) => entry.datum);
  return {
    data: sorted.slice(0, SPACE_CHART_MAX_BARS),
    omitted: Math.max(0, sorted.length - SPACE_CHART_MAX_BARS),
  };
}

const MAX_SLICES = 9;

/** The largest slices, with the rest folded into "Other" where adding the values is meaningful. */
export function donutSlices(
  data: ReadonlyArray<ChartDatum>,
  config: ChartConfig,
): { readonly slices: ReadonlyArray<ChartDatum>; readonly other: number | null } {
  const positive = data
    .filter((datum) => datum.value !== null && datum.value > 0)
    .map((datum, index) => ({ datum, index }))
    .sort((a, b) => (b.datum.value ?? 0) - (a.datum.value ?? 0) || a.index - b.index)
    .map((entry) => entry.datum);
  const slices = positive.slice(0, MAX_SLICES);
  const rest = positive.slice(MAX_SLICES);
  const foldable = config.y === null || config.y.function === "sum";
  const other = rest.reduce((sum, datum) => sum + (datum.value ?? 0), 0);
  return { slices, other: foldable && rest.length > 0 ? other : null };
}

const decimals = (step: number) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
const NICE = [1, 2, 5, 10] as const;

/** Axis ticks on 1, 2 or 5 times a power of ten; the domain always includes 0. */
export function niceTicks(
  min: number,
  max: number,
  count = 5,
): { readonly min: number; readonly max: number; readonly ticks: ReadonlyArray<number> } {
  const lo = Math.min(min, 0);
  const hi = Math.max(max, 0);
  if (lo === hi) return { min: 0, max: 1, ticks: [0, 1] };
  const raw = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  let step = (NICE.find((nice) => raw / magnitude <= nice + 1e-9) ?? 10) * magnitude;
  let niceMin = Math.floor(lo / step + 1e-9) * step;
  let niceMax = Math.ceil(hi / step - 1e-9) * step;
  while ((niceMax - niceMin) / step > count + 1e-9) {
    step *= 2;
    niceMin = Math.floor(lo / step + 1e-9) * step;
    niceMax = Math.ceil(hi / step - 1e-9) * step;
  }
  const places = decimals(step);
  const round = (value: number) => Number(value.toFixed(places));
  const ticks: number[] = [];
  for (let at = niceMin; at <= niceMax + step / 2; at += step) ticks.push(round(at));
  return { min: round(niceMin), max: round(niceMax), ticks };
}

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): (value: number) => number {
  const span = domain[1] - domain[0];
  return (value) =>
    span === 0 ? range[0] : range[0] + ((value - domain[0]) / span) * (range[1] - range[0]);
}

/** `n` bands across `length`, with a gap of 0.25 of a band (at least 2px) between them. */
export function bandLayout(
  n: number,
  length: number,
  gap = 0.25,
): { readonly band: number; readonly offset: (index: number) => number } {
  const step = length / Math.max(n, 1);
  const gapPx = Math.max(0, Math.min(Math.max(2, step * gap), step - 1));
  return {
    band: Math.max(1, step - gapPx),
    offset: (index) => index * step + gapPx / 2,
  };
}

const FULL = Math.PI * 2;

/** Radians from 12 o'clock, clockwise. Values at or below zero get an empty arc. */
export function donutAngles(
  values: ReadonlyArray<number>,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  let at = -Math.PI / 2;
  return values.map((value) => {
    const start = at;
    if (total > 0) at += (Math.max(0, value) / total) * FULL;
    return { start, end: at };
  });
}

const n2 = (value: number) => Number(value.toFixed(2));
const point = (cx: number, cy: number, radius: number, angle: number) =>
  `${n2(cx + radius * Math.cos(angle))} ${n2(cy + radius * Math.sin(angle))}`;

/** A ring segment; a full circle draws as two arcs because one arc cannot close on itself. */
export function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  start: number,
  end: number,
): string {
  if (end - start >= FULL - 1e-6) {
    const ring = (radius: number, sweep: 0 | 1) =>
      `M ${point(cx, cy, radius, start)} A ${radius} ${radius} 0 1 ${sweep} ${point(cx, cy, radius, start + Math.PI)} A ${radius} ${radius} 0 1 ${sweep} ${point(cx, cy, radius, start)} Z`;
    return inner > 0 ? `${ring(outer, 1)} ${ring(inner, 0)}` : ring(outer, 1);
  }
  const large = end - start > Math.PI ? 1 : 0;
  const tail =
    inner > 0
      ? `L ${point(cx, cy, inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(cx, cy, inner, start)} Z`
      : `L ${n2(cx)} ${n2(cy)} Z`;
  return `M ${point(cx, cy, outer, start)} A ${outer} ${outer} 0 ${large} 1 ${point(cx, cy, outer, end)} ${tail}`;
}

export function linePath(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): string {
  return points.map((p, index) => `${index === 0 ? "M" : "L"} ${n2(p.x)} ${n2(p.y)}`).join(" ");
}

const FUNCTION_NAMES = {
  sum: "Sum",
  average: "Average",
  median: "Median",
  min: "Minimum",
  max: "Maximum",
} as const;

export function chartTitle(config: ChartConfig, xName: string, yName: string | null): string {
  return config.y === null
    ? `Count by ${xName}`
    : `${FUNCTION_NAMES[config.y.function]} of ${yName ?? "value"} by ${xName}`;
}
