import type { ChartDatum, ChartKind } from "@t2code/client-runtime/spaces";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { observeResize } from "~/lib/observeResize";
import { DonutLegend, DonutPlot, donutTooltipLabel } from "./ChartDonut";
import { BarPlot, HorizontalBarPlot, LinePlot, type Hover } from "./ChartPlots";
import { ChartTable } from "./ChartTable";

const FALLBACK_WIDTH = 640;

/** The width of the element this ref lands on, kept current by the shared resize observer. */
function useChartWidth() {
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const ref = (element: HTMLElement | null) => {
    if (element === null) return;
    setWidth(Math.floor(element.clientWidth) || FALLBACK_WIDTH);
    return observeResize(element, (entries) => {
      const next = entries.at(-1)?.contentRect.width;
      if (next !== undefined && next > 0) setWidth(Math.floor(next));
    });
  };
  return [ref, width] as const;
}

export interface ChartFigureProps {
  readonly kind: ChartKind;
  readonly data: ReadonlyArray<ChartDatum>;
  /** Donut only: the folded remainder. */
  readonly other: number | null;
  readonly title: string;
  readonly xLabel: string;
  readonly yLabel: string;
  readonly format: (value: number) => string;
  readonly showValues: boolean;
  readonly colorByOption: boolean;
  /** Donut only: the text in the hole. */
  readonly centerLabel?: string | null;
  /** Present when marks open the rows behind them. */
  readonly onSelect?: (datum: ChartDatum) => void;
}

function Tooltip({
  hover,
  label,
  value,
}: {
  readonly hover: Hover;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div
      role="presentation"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2 py-1 text-popover-foreground text-xs shadow-sm"
      style={{ left: hover.x, top: Math.max(hover.y - 6, 24) }}
    >
      <div className="max-w-48 truncate font-medium">{label}</div>
      <div className="tabular-nums">{value}</div>
    </div>
  );
}

/** The figure: a title, the chart drawn as SVG, and the same data as a table behind a toggle. */
export function ChartFigure(props: ChartFigureProps) {
  const { kind, data, other, title, xLabel, yLabel, format, onSelect } = props;
  const [ref, width] = useChartWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const [asTable, setAsTable] = useState(false);
  const tipped =
    hover === null
      ? null
      : kind === "donut"
        ? donutTooltipLabel(data, other, hover.index)
        : (data[hover.index] ?? null);
  const plot = { ...props, width, onHover: setHover };
  return (
    <figure ref={ref} className="flex flex-col gap-2">
      <figcaption className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{title}</span>
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={asTable}
          onClick={() => {
            setHover(null);
            setAsTable(!asTable);
          }}
        >
          {asTable ? "View as chart" : "View as table"}
        </Button>
      </figcaption>
      {asTable ? null : (
        <div className="flex flex-wrap items-center gap-4">
          <div
            className="relative"
            style={{ width: kind === "donut" ? Math.min(width, 280) : width }}
          >
            {kind === "bar" ? <BarPlot {...plot} /> : null}
            {kind === "line" ? <LinePlot {...plot} /> : null}
            {kind === "horizontal_bar" ? <HorizontalBarPlot {...plot} /> : null}
            {kind === "donut" ? (
              <DonutPlot
                data={data}
                other={other}
                width={width}
                centerLabel={props.centerLabel ?? null}
                onHover={setHover}
                {...(onSelect === undefined ? {} : { onSelect })}
              />
            ) : null}
            {hover === null || tipped === null ? null : (
              <Tooltip
                hover={hover}
                label={tipped.label}
                value={tipped.value === null ? "No value" : format(tipped.value)}
              />
            )}
          </div>
          {kind === "donut" ? <DonutLegend data={data} other={other} format={format} /> : null}
        </div>
      )}
      <ChartTable
        title={title}
        xLabel={xLabel}
        yLabel={yLabel}
        data={data}
        other={other}
        format={format}
        visible={asTable}
        {...(onSelect === undefined ? {} : { onSelect })}
      />
    </figure>
  );
}
