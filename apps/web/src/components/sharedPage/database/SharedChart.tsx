import {
  chartData,
  chartTitle,
  donutSlices,
  formatAggregate,
  type ChartConfig,
  type ChartKind,
} from "@t2code/client-runtime/spaces";
import {
  SPACE_CHART_TYPES,
  SPACE_CHART_Y_FUNCTIONS,
  SpacePropertyId,
  type SpaceGroupBucket,
} from "@t2code/contracts/spaces";

import { ChartFigure } from "~/spaces/databases/chart/ChartSvg";
import { optionHintFor } from "./cells";
import type { ViewProps } from "./parts";
import { orderBuckets } from "./viewModel";

const COUNT = new Intl.NumberFormat("en-US");

const isKind = (value: unknown): value is ChartKind =>
  (SPACE_CHART_TYPES as ReadonlyArray<unknown>).includes(value);

/** The chart settings of a shared view: the same defaults as the signed-in reader, defensive reads. */
function configOf(layout: unknown): ChartConfig {
  const record: Readonly<Record<string, unknown>> =
    typeof layout === "object" && layout !== null && !Array.isArray(layout)
      ? Object.fromEntries(Object.entries(layout))
      : {};
  const y = record.y;
  const yRecord =
    typeof y === "object" && y !== null && !Array.isArray(y)
      ? Object.fromEntries(Object.entries(y))
      : {};
  const fn = SPACE_CHART_Y_FUNCTIONS.find((candidate) => candidate === yRecord.function);
  return {
    kind: isKind(record.chartType) ? record.chartType : "bar",
    y:
      typeof yRecord.property === "string" && fn !== undefined
        ? { property: SpacePropertyId.make(yRecord.property), function: fn }
        : null,
    colorByOption: record.colorByOption !== false,
    sortByValue:
      record.sortByValue === "ascending" || record.sortByValue === "descending"
        ? record.sortByValue
        : null,
    showValues: record.showValues === true,
  };
}

export function SharedChart(props: ViewProps) {
  const { view, source, data, known } = props;
  const config = configOf(view.layout);
  const groupId = view.group?.property;
  const groupProperty = groupId === undefined ? undefined : source.properties[groupId];
  if (groupId === undefined || data.groups === null || groupProperty === undefined)
    return <p className="py-4 text-muted-foreground text-sm">This chart has no X axis yet.</p>;

  const { y } = config;
  const buckets = orderBuckets(data.groups, view.group?.order).map((bucket): SpaceGroupBucket => ({
    key: bucket.key,
    ...(bucket.label === undefined ? {} : { label: bucket.label }),
    count: bucket.count,
    rows: [],
    nextCursor: null,
    ...(y === null
      ? {}
      : {
          aggregates: (bucket.aggregates ?? []).flatMap((entry) =>
            entry.property === y.property && entry.number !== undefined
              ? [{ property: entry.property, function: y.function, number: entry.number }]
              : [],
          ),
        }),
  }));
  const { data: points, omitted } = chartData({
    groups: buckets,
    config,
    group: { property: SpacePropertyId.make(groupId) },
    groupProperty: known.get(groupId) ?? null,
    propertyName: groupProperty.name,
    optionHint: optionHintFor(data.options),
  });
  if (points.length === 0)
    return <p className="py-4 text-muted-foreground text-sm">No rows to chart.</p>;

  const yProperty = y === null ? undefined : source.properties[y.property];
  const yKnown = y === null ? null : (known.get(y.property) ?? null);
  const format = (value: number) =>
    y === null
      ? COUNT.format(value)
      : formatAggregate({ property: y.property, function: y.function, number: value }, yKnown);
  const donut = config.kind === "donut" ? donutSlices(points, config) : null;
  const shown = donut === null ? points : donut.slices;
  const total =
    donut !== null && (y === null || y.function === "sum")
      ? shown.reduce((sum, datum) => sum + (datum.value ?? 0), donut.other ?? 0)
      : null;
  return (
    <div className="flex flex-col gap-2">
      <ChartFigure
        kind={config.kind}
        data={shown}
        other={donut?.other ?? null}
        title={chartTitle(config, groupProperty.name, yProperty?.name ?? null)}
        xLabel={groupProperty.name}
        yLabel={y === null ? "Count" : (yProperty?.name ?? "Value")}
        format={format}
        showValues={config.showValues}
        colorByOption={config.colorByOption}
        centerLabel={total === null ? null : format(total)}
      />
      {omitted > 0 || data.groupsTruncated ? (
        <p className="text-muted-foreground text-xs">Some groups are not shown.</p>
      ) : null}
    </div>
  );
}
