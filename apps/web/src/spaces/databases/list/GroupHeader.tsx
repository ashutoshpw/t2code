import { ChevronRightIcon } from "lucide-react";
import { memo } from "react";
import type { SpaceGroupBucket } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { OptionChip } from "../primitives/OptionChip";
import { GROUP_HEIGHT } from "../table/gridItems";
import type { GroupLabel } from "../table/groupLabel";

/** A bucket's header: collapse toggle, label and count. */
export const GroupHeader = memo(function GroupHeader({
  id,
  index,
  top,
  bucket,
  label,
  collapsed,
  onToggle,
}: {
  readonly id: string;
  readonly index: number;
  readonly top: number;
  readonly bucket: SpaceGroupBucket;
  readonly label: GroupLabel;
  readonly collapsed: boolean;
  readonly onToggle: (id: string) => void;
}) {
  return (
    <div
      role="presentation"
      data-item-index={index}
      className="absolute inset-x-0 flex items-center gap-2 px-2"
      style={{ top, height: GROUP_HEIGHT }}
    >
      <button
        type="button"
        data-nav=""
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${label.text}`}
        className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => onToggle(id)}
      >
        <ChevronRightIcon className={cn("size-3.5", !collapsed && "rotate-90")} />
      </button>
      {label.color === undefined ? (
        <span className="text-sm font-medium">{label.text}</span>
      ) : (
        <OptionChip name={label.text} color={label.color} />
      )}
      <span className="text-xs text-muted-foreground">{bucket.count}</span>
    </div>
  );
});
