import { arcPath, donutAngles, type ChartDatum } from "@t2code/client-runtime/spaces";

import type { SpaceDatabaseColor } from "@t2code/contracts/spaces";

import { CHART_DOT_CLASS, CHART_FILL_CLASS, sliceColor } from "./chartColors";
import type { Hover } from "./ChartPlots";

const SIZE = 280;

interface Slice {
  readonly key: string;
  readonly datum: ChartDatum | null;
  readonly label: string;
  readonly value: number;
  readonly color: SpaceDatabaseColor;
}

/** The slices, with "Other" last in grey. */
function slicesOf(data: ReadonlyArray<ChartDatum>, other: number | null): ReadonlyArray<Slice> {
  const slices = data.map((datum, index): Slice => ({
    key: datum.id,
    datum,
    label: datum.label,
    value: datum.value ?? 0,
    color: sliceColor(datum.color, index),
  }));
  return other === null
    ? slices
    : [...slices, { key: "other", datum: null, label: "Other", value: other, color: "gray" }];
}

export function DonutPlot({
  data,
  other,
  width,
  centerLabel,
  onHover,
  onSelect,
}: {
  readonly data: ReadonlyArray<ChartDatum>;
  readonly other: number | null;
  readonly width: number;
  readonly centerLabel: string | null;
  readonly onHover: (hover: Hover | null) => void;
  readonly onSelect?: (datum: ChartDatum) => void;
}) {
  const slices = slicesOf(data, other);
  const size = Math.min(width, SIZE);
  const outer = size / 2 - 8;
  const inner = outer * 0.6;
  const angles = donutAngles(slices.map((slice) => slice.value));
  return (
    <svg width={size} height={size} aria-hidden="true" focusable="false">
      {slices.map((slice, index) => {
        const angle = angles[index];
        if (angle === undefined || angle.end - angle.start <= 0) return null;
        const mid = (angle.start + angle.end) / 2;
        const radius = (outer + inner) / 2;
        const picked = slice.datum;
        const selectable = onSelect !== undefined && picked !== null;
        return (
          <path
            key={slice.key}
            d={arcPath(size / 2, size / 2, outer, inner, angle.start, angle.end)}
            strokeWidth={2}
            className={`${CHART_FILL_CLASS[slice.color]} stroke-background ${selectable ? "cursor-pointer" : ""}`}
            onPointerEnter={() =>
              onHover({
                index,
                x: size / 2 + radius * Math.cos(mid),
                y: size / 2 + radius * Math.sin(mid),
              })
            }
            onPointerLeave={() => onHover(null)}
            onClick={selectable ? () => onSelect(picked) : undefined}
          />
        );
      })}
      {centerLabel === null ? null : (
        <text
          x={size / 2}
          y={size / 2 + 5}
          textAnchor="middle"
          className="fill-foreground text-base font-medium"
        >
          {centerLabel}
        </text>
      )}
    </svg>
  );
}

/** Colour encodes the slice here, so the legend names every slice with its value and share. */
export function DonutLegend({
  data,
  other,
  format,
}: {
  readonly data: ReadonlyArray<ChartDatum>;
  readonly other: number | null;
  readonly format: (value: number) => string;
}) {
  const slices = slicesOf(data, other);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  return (
    <ul className="flex min-w-40 flex-1 flex-col gap-1 text-xs">
      {slices.map((slice) => (
        <li key={slice.key} className="flex items-center gap-2">
          <span className={`size-2.5 shrink-0 rounded-full ${CHART_DOT_CLASS[slice.color]}`} />
          <span className="min-w-0 flex-1 truncate">{slice.label}</span>
          <span className="tabular-nums">{format(slice.value)}</span>
          <span className="w-10 text-right text-muted-foreground tabular-nums">
            {total > 0 ? `${Math.round((slice.value / total) * 100)}%` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

export const donutTooltipLabel = (
  data: ReadonlyArray<ChartDatum>,
  other: number | null,
  index: number,
): { readonly label: string; readonly value: number | null } | null => {
  const slice = slicesOf(data, other)[index];
  return slice === undefined ? null : { label: slice.label, value: slice.value };
};
