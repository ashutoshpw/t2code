import { type GroupLabel, canonicalJson, laneCell } from "@t2code/client-runtime/spaces";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { SpaceGroupBucket, SpaceGroupKey } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { OptionChip } from "../primitives/OptionChip";

/** Lanes of a sub-grouped board: a header row of columns, then one section per lane. */
export function BoardLanes({
  columns,
  lanes,
  collapsed,
  onToggle,
  headerOf,
  laneLabelOf,
  columnWidth,
  renderCell,
}: {
  readonly columns: ReadonlyArray<SpaceGroupBucket>;
  readonly lanes: ReadonlyArray<SpaceGroupKey>;
  readonly collapsed: ReadonlySet<string>;
  readonly onToggle: (laneId: string) => void;
  /** Label, count and compact calculation of a column. */
  readonly headerOf: (bucket: SpaceGroupBucket) => {
    readonly label: GroupLabel;
    readonly aggregates: string;
  };
  readonly laneLabelOf: (lane: SpaceGroupKey) => GroupLabel;
  readonly columnWidth: number;
  readonly renderCell: (
    bucket: SpaceGroupBucket,
    lane: SpaceGroupKey,
    cell: NonNullable<SpaceGroupBucket["subGroups"]>[number],
  ) => ReactNode;
}) {
  return (
    <div className="flex min-w-max flex-col gap-3">
      <div className="flex gap-3">
        {columns.map((bucket) => {
          const { label, aggregates } = headerOf(bucket);
          return (
            <div
              key={canonicalJson(bucket.key)}
              className="flex shrink-0 items-center gap-1 px-2"
              style={{ width: columnWidth }}
            >
              {label.color === undefined ? (
                <span className="truncate text-sm font-medium">{label.text}</span>
              ) : (
                <OptionChip name={label.text} color={label.color} />
              )}
              <span className="text-xs text-muted-foreground">{bucket.count}</span>
              {aggregates === "" ? null : (
                <span className="truncate text-xs text-muted-foreground">{aggregates}</span>
              )}
            </div>
          );
        })}
      </div>
      {lanes.map((lane) => {
        const id = canonicalJson(lane);
        const label = laneLabelOf(lane);
        const isCollapsed = collapsed.has(id);
        const count = columns.reduce(
          (sum, bucket) => sum + (laneCell(bucket, lane)?.count ?? 0),
          0,
        );
        return (
          <section key={id} aria-label={`Lane ${label.text}`} className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-expanded={!isCollapsed}
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} lane ${label.text}`}
                className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onToggle(id)}
              >
                <ChevronRightIcon className={cn("size-3.5", !isCollapsed && "rotate-90")} />
              </button>
              {label.color === undefined ? (
                <span className="text-sm font-medium">{label.text}</span>
              ) : (
                <OptionChip name={label.text} color={label.color} />
              )}
              <span className="text-xs text-muted-foreground">{count}</span>
            </div>
            {isCollapsed ? null : (
              <div className="flex items-start gap-3">
                {columns.map((bucket) => {
                  const cell = laneCell(bucket, lane);
                  return cell === undefined ? (
                    <div
                      key={canonicalJson(bucket.key)}
                      className="shrink-0"
                      style={{ width: columnWidth }}
                    />
                  ) : (
                    renderCell(bucket, lane, cell)
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
