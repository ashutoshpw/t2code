import {
  bandLayout,
  linePath,
  linearScale,
  niceTicks,
  type ChartDatum,
} from "@t2code/client-runtime/spaces";
import type { ReactNode } from "react";

import { CHART_FILL_CLASS, CHART_STROKE_CLASS, seriesColor } from "./chartColors";

export interface Hover {
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

export interface PlotProps {
  readonly data: ReadonlyArray<ChartDatum>;
  readonly width: number;
  readonly format: (value: number) => string;
  readonly showValues: boolean;
  readonly xLabel: string;
  readonly yLabel: string;
  readonly colorByOption: boolean;
  readonly onHover: (hover: Hover | null) => void;
  readonly onSelect?: (datum: ChartDatum) => void;
}

const TEXT = "fill-muted-foreground text-2xs";
const PLOT_HEIGHT = 280;
const ROW = 28;

const domainOf = (data: ReadonlyArray<ChartDatum>) => {
  const values = data.flatMap((datum) => (datum.value === null ? [] : [datum.value]));
  return niceTicks(Math.min(0, ...values), Math.max(0, ...values));
};

const clip = (text: string, chars: number) =>
  text.length <= chars ? text : `${text.slice(0, Math.max(1, chars - 1))}…`;

const horizontalHeight = (count: number) => count * ROW + 48;

/** Hit areas: invisible, at least 24px wide, so thin bars and markers are easy to reach. */
function HitRect({
  index,
  datum,
  x,
  y,
  width,
  height,
  anchor,
  props,
}: {
  readonly index: number;
  readonly datum: ChartDatum;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly props: PlotProps;
}) {
  const { onHover, onSelect } = props;
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      fill="transparent"
      className={onSelect === undefined ? undefined : "cursor-pointer"}
      onPointerEnter={() => onHover({ index, ...anchor })}
      onPointerLeave={() => onHover(null)}
      onClick={onSelect === undefined ? undefined : () => onSelect(datum)}
    />
  );
}

interface Geometry {
  readonly left: number;
  readonly top: number;
  readonly plotW: number;
  readonly plotH: number;
  readonly slot: number;
  readonly band: number;
  readonly offset: (index: number) => number;
  readonly scaleY: (value: number) => number;
}

const MARGIN = { left: 56, right: 12, top: 12, bottom: 60 } as const;

function geometryOf({ data, width }: PlotProps): Geometry {
  const { left, right, top, bottom } = MARGIN;
  const plotW = Math.max(40, width - left - right);
  const plotH = PLOT_HEIGHT - top - bottom;
  const domain = domainOf(data);
  const { band, offset } = bandLayout(data.length, plotW);
  return {
    left,
    top,
    plotW,
    plotH,
    slot: plotW / Math.max(1, data.length),
    band,
    offset,
    scaleY: linearScale([domain.min, domain.max], [top + plotH, top]),
  };
}

/** Axes, gridlines and titles of the vertical charts; the children draw the data between them. */
function Cartesian({
  props,
  geometry,
  children,
}: {
  readonly props: PlotProps;
  readonly geometry: Geometry;
  readonly children: ReactNode;
}) {
  const { data, width, format, xLabel, yLabel } = props;
  const { left, top, plotW, plotH, slot, scaleY } = geometry;
  const ticks = domainOf(data).ticks;
  const stride = Math.max(1, Math.ceil(32 / slot));
  const chars = Math.max(3, Math.floor((slot * stride) / 6.5));
  const hitW = Math.max(24, slot);
  return (
    <svg width={width} height={PLOT_HEIGHT} aria-hidden="true" focusable="false">
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={left}
            x2={left + plotW}
            y1={scaleY(tick)}
            y2={scaleY(tick)}
            className="stroke-border"
            strokeWidth={1}
          />
          <text x={left - 6} y={scaleY(tick) + 4} textAnchor="end" className={TEXT}>
            {format(tick)}
          </text>
        </g>
      ))}
      {children}
      {data.map((datum, index) =>
        index % stride === 0 ? (
          <text
            key={datum.id}
            x={left + index * slot + slot / 2}
            y={top + plotH + 16}
            textAnchor="middle"
            className={TEXT}
          >
            {clip(datum.label, chars)}
          </text>
        ) : null,
      )}
      <text
        x={left + plotW / 2}
        y={PLOT_HEIGHT - 8}
        textAnchor="middle"
        className="fill-foreground text-xs"
      >
        {xLabel}
      </text>
      <text
        transform={`translate(14 ${top + plotH / 2}) rotate(-90)`}
        textAnchor="middle"
        className="fill-foreground text-xs"
      >
        {yLabel}
      </text>
      {data.map((datum, index) => (
        <HitRect
          key={datum.id}
          index={index}
          datum={datum}
          x={left + index * slot + slot / 2 - hitW / 2}
          y={top}
          width={hitW}
          height={plotH}
          anchor={{
            x: left + index * slot + slot / 2,
            y: scaleY(Math.max(0, datum.value ?? 0)),
          }}
          props={props}
        />
      ))}
    </svg>
  );
}

export function BarPlot(props: PlotProps) {
  const { data, format, showValues, colorByOption } = props;
  const geometry = geometryOf(props);
  const { left, scaleY, band, offset } = geometry;
  return (
    <Cartesian props={props} geometry={geometry}>
      {data.map((datum, index) => {
        if (datum.value === null) return null;
        const base = scaleY(0);
        const end = scaleY(datum.value);
        const x = left + offset(index);
        return (
          <g key={datum.id}>
            <rect
              x={x}
              y={Math.min(base, end)}
              width={band}
              height={Math.max(1, Math.abs(base - end))}
              rx={band < 12 ? 2 : 4}
              className={CHART_FILL_CLASS[seriesColor(colorByOption ? datum.color : null)]}
            />
            {showValues ? (
              <text
                x={x + band / 2}
                y={datum.value >= 0 ? end - 4 : end + 12}
                textAnchor="middle"
                className="fill-foreground text-2xs"
              >
                {format(datum.value)}
              </text>
            ) : null}
          </g>
        );
      })}
    </Cartesian>
  );
}

export function LinePlot(props: PlotProps) {
  const { data, format, showValues } = props;
  const geometry = geometryOf(props);
  const { left, scaleY, slot } = geometry;
  const points = data.flatMap((datum, index) =>
    datum.value === null
      ? []
      : [{ datum, x: left + index * slot + slot / 2, y: scaleY(datum.value) }],
  );
  return (
    <Cartesian props={props} geometry={geometry}>
      <path
        d={linePath(points)}
        fill="none"
        strokeWidth={2}
        strokeLinejoin="round"
        className={CHART_STROKE_CLASS.blue}
      />
      {points.map(({ datum, x, y }) => (
        <g key={datum.id}>
          <circle
            cx={x}
            cy={y}
            r={4}
            strokeWidth={2}
            className={`${CHART_FILL_CLASS.blue} stroke-background`}
          />
          {showValues && datum.value !== null ? (
            <text x={x} y={y - 9} textAnchor="middle" className="fill-foreground text-2xs">
              {format(datum.value)}
            </text>
          ) : null}
        </g>
      ))}
    </Cartesian>
  );
}

export function HorizontalBarPlot(props: PlotProps) {
  const { data, width, format, showValues, colorByOption, xLabel, yLabel } = props;
  const left = 148;
  const right = 40;
  const top = 8;
  const plotW = Math.max(40, width - left - right);
  const plotH = data.length * ROW;
  const height = horizontalHeight(data.length);
  const domain = domainOf(data);
  const scaleX = linearScale([domain.min, domain.max], [left, left + plotW]);
  const { band, offset } = bandLayout(data.length, plotH);
  return (
    <svg width={width} height={height} aria-hidden="true" focusable="false">
      {domain.ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={scaleX(tick)}
            x2={scaleX(tick)}
            y1={top}
            y2={top + plotH}
            className="stroke-border"
            strokeWidth={1}
          />
          <text x={scaleX(tick)} y={top + plotH + 14} textAnchor="middle" className={TEXT}>
            {format(tick)}
          </text>
        </g>
      ))}
      {data.map((datum, index) => {
        const y = top + offset(index);
        const base = scaleX(0);
        const end = scaleX(datum.value ?? 0);
        return (
          <g key={datum.id}>
            <text x={left - 6} y={y + band / 2 + 4} textAnchor="end" className={TEXT}>
              {clip(datum.label, 18)}
            </text>
            {datum.value === null ? null : (
              <rect
                x={Math.min(base, end)}
                y={y}
                width={Math.max(1, Math.abs(end - base))}
                height={band}
                rx={band < 12 ? 2 : 4}
                className={CHART_FILL_CLASS[seriesColor(colorByOption ? datum.color : null)]}
              />
            )}
            {showValues && datum.value !== null ? (
              <text
                x={Math.max(base, end) + 4}
                y={y + band / 2 + 4}
                className="fill-foreground text-2xs"
              >
                {format(datum.value)}
              </text>
            ) : null}
            <HitRect
              index={index}
              datum={datum}
              x={left}
              y={top + index * ROW}
              width={plotW}
              height={ROW}
              anchor={{ x: end, y: y }}
              props={props}
            />
          </g>
        );
      })}
      <text
        x={left + plotW / 2}
        y={height - 6}
        textAnchor="middle"
        className="fill-foreground text-xs"
      >
        {yLabel}
      </text>
      <text
        transform={`translate(10 ${top + plotH / 2}) rotate(-90)`}
        textAnchor="middle"
        className="fill-foreground text-xs"
      >
        {xLabel}
      </text>
    </svg>
  );
}
