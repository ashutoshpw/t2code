import {
  chartAggregates,
  chartConfig,
  chartData,
  chartTitle,
  donutSlices,
  formatAggregate,
  type ChartDatum,
} from "@t2code/client-runtime/spaces";
import { SPACE_CHART_MAX_BARS } from "@t2code/contracts/spaces";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { useViewQuery } from "../data/useViewQuery";
import { RowsError } from "../list/ListStates";
import { GroupsTruncatedNote } from "../primitives/GroupsTruncatedNote";
import { useDatabase, useOpenControl } from "../shell/context";
import { DatabaseSkeleton } from "../shell/DatabaseSkeleton";
import type { DatabaseViewProps } from "../shell/viewTypes";
import { ChartFigure } from "./ChartSvg";
import { ChartPeek } from "./ChartPeek";

const COUNT = new Intl.NumberFormat("en-US");

export default function ChartView({ search }: DatabaseViewProps) {
  const { model, view, known, columns, optionHint } = useDatabase();
  const [, openControl] = useOpenControl();
  const [peek, setPeek] = useState<ChartDatum | null>(null);
  const chart = known?.type === "chart" ? known : null;
  const config = chart === null ? null : chartConfig(chart);
  const group = chart?.group;
  const xColumn =
    group === undefined ? undefined : columns.find((entry) => entry.property.id === group.property);
  const query = useViewQuery(view, [], {
    mode: "groups",
    rowsPerGroup: 0,
    search,
    ...(config === null ? {} : { aggregates: chartAggregates(config) }),
  });
  if (config === null || group === undefined || xColumn === undefined)
    return (
      <section
        aria-label="Set up the chart"
        className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center"
      >
        <p className="text-sm font-medium">Choose a property for the X axis</p>
        {model.permissions.views ? (
          <Button size="sm" variant="outline" onClick={() => openControl("group")}>
            Choose X axis
          </Button>
        ) : null}
      </section>
    );
  if (query.groups === null)
    return query.status === "error" ? (
      <RowsError query={query} fallback="Couldn't load the chart." />
    ) : (
      <DatabaseSkeleton />
    );

  const yColumn =
    config.y === null
      ? undefined
      : columns.find((entry) => entry.property.id === config.y?.property);
  const { data, omitted } = chartData({
    groups: query.groups,
    config,
    group,
    groupProperty: xColumn.known,
    propertyName: xColumn.property.name,
    optionHint,
  });
  if (data.every((datum) => datum.count === 0))
    return (
      <p role="status" className="px-1 py-4 text-sm text-muted-foreground">
        No rows to chart
      </p>
    );
  const y = config.y;
  const format = (value: number) =>
    y === null
      ? COUNT.format(value)
      : formatAggregate(
          { property: y.property, function: y.function, number: value },
          yColumn?.known ?? null,
        );
  const xName = xColumn.property.name;
  const yName = y === null ? "Count" : (yColumn?.property.name ?? "Value");
  const title = chartTitle(config, xName, yColumn?.property.name ?? null);
  const donut = config.kind === "donut" ? donutSlices(data, config) : null;
  const shown = donut === null ? data : donut.slices;
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
        title={title}
        xLabel={xName}
        yLabel={yName}
        format={format}
        showValues={config.showValues}
        colorByOption={config.colorByOption}
        centerLabel={total === null ? null : format(total)}
        onSelect={setPeek}
      />
      {omitted > 0 || query.groupsTruncated ? (
        <GroupsTruncatedNote count={omitted > 0 ? SPACE_CHART_MAX_BARS : data.length} />
      ) : null}
      {peek === null ? null : (
        <ChartPeek
          datum={peek}
          search={search}
          yProperty={y?.property ?? null}
          onClose={() => setPeek(null)}
        />
      )}
    </div>
  );
}
