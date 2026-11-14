import type { ChartDatum } from "@t2code/client-runtime/spaces";

import { cn } from "~/lib/utils";

/** The chart's data as a real table: always in the accessibility tree, visible on request. */
export function ChartTable({
  title,
  xLabel,
  yLabel,
  data,
  other,
  format,
  visible,
  onSelect,
}: {
  readonly title: string;
  readonly xLabel: string;
  readonly yLabel: string;
  readonly data: ReadonlyArray<ChartDatum>;
  readonly other: number | null;
  readonly format: (value: number) => string;
  readonly visible: boolean;
  readonly onSelect?: (datum: ChartDatum) => void;
}) {
  return (
    <table className={cn("w-full text-xs", visible ? "" : "sr-only")}>
      <caption className="sr-only">{title}</caption>
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th scope="col" className="px-2 py-1.5 font-medium">
            {xLabel}
          </th>
          <th scope="col" className="px-2 py-1.5 text-right font-medium">
            {yLabel}
          </th>
          {onSelect === undefined ? null : (
            <th scope="col" className="px-2 py-1.5">
              <span className="sr-only">Rows</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {data.map((datum) => (
          <tr key={datum.id} className="border-b last:border-0">
            <th scope="row" className="px-2 py-1.5 text-left font-normal">
              {datum.label}
            </th>
            <td className="px-2 py-1.5 text-right tabular-nums">
              {datum.value === null ? "No value" : format(datum.value)}
            </td>
            {onSelect === undefined ? null : (
              <td className="px-2 py-1.5 text-right">
                <button
                  type="button"
                  aria-label={`Show rows for ${datum.label}`}
                  className="rounded-sm px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => onSelect(datum)}
                >
                  Show rows
                </button>
              </td>
            )}
          </tr>
        ))}
        {other === null ? null : (
          <tr className="border-b last:border-0">
            <th scope="row" className="px-2 py-1.5 text-left font-normal">
              Other
            </th>
            <td className="px-2 py-1.5 text-right tabular-nums">{format(other)}</td>
            {onSelect === undefined ? null : <td />}
          </tr>
        )}
      </tbody>
    </table>
  );
}
