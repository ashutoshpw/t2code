import { ChevronRightIcon } from "lucide-react";
import type { SpaceGroupBucket } from "@t2code/contracts/spaces";

import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { OptionChip } from "../primitives/OptionChip";
import type { GroupLabel } from "../table/groupLabel";
import type { TimelineGroupHandlers, TimelineLine } from "./timelineLines";

const BUTTON =
  "inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The text side of a group header or a `Load more` line: the side pane shows it, or the track when the pane is hidden. */
export function TimelineLineLabel({
  line,
  labelOf,
  groups,
}: {
  readonly line: Exclude<TimelineLine, { kind: "row" }>;
  readonly labelOf: (bucket: SpaceGroupBucket) => GroupLabel;
  readonly groups: TimelineGroupHandlers;
}) {
  if (line.kind === "more")
    return (
      <div className="flex h-full items-center px-2">
        {line.loading ? (
          <Skeleton className="h-5 w-28" />
        ) : (
          <button type="button" className={BUTTON} onClick={() => groups.loadBucket(line.group)}>
            Load more
          </button>
        )}
      </div>
    );
  const label = labelOf(line.bucket);
  return (
    <div className="flex h-full items-center gap-2 px-2">
      <button
        type="button"
        aria-expanded={!line.collapsed}
        aria-label={`${line.collapsed ? "Expand" : "Collapse"} ${label.text}`}
        className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => groups.toggle(line.id)}
      >
        <ChevronRightIcon className={cn("size-3.5", !line.collapsed && "rotate-90")} />
      </button>
      {label.color === undefined ? (
        <span className="truncate text-sm font-medium">{label.text}</span>
      ) : (
        <OptionChip name={label.text} color={label.color} />
      )}
      <span className="text-xs text-muted-foreground">{line.bucket.count}</span>
    </div>
  );
}
