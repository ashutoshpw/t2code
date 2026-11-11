import { ChevronRightIcon, PlusIcon } from "lucide-react";
import type { SpaceGroupBucket, SpaceGroupKey } from "@t2code/contracts/spaces";
import { type GroupLabel, canonicalJson } from "@t2code/client-runtime/spaces";

import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { OptionChip } from "../primitives/OptionChip";
import { useAdding, type GridEditStore } from "./gridEditStore";
import { GROUP_HEIGHT, MAX_TREE_DEPTH, ROW_HEIGHT } from "./gridItems";
import { INDENT } from "./tree";
import type { GridHandlers } from "./tableTypes";

const ROW = "absolute start-0 flex w-full items-center border-b border-border/60";
const STICKY = "sticky start-0 flex items-center gap-2 px-2";

export function GroupHeaderRow({
  id,
  bucket,
  label,
  collapsed,
  top,
  ariaRow,
  grid,
}: {
  readonly id: string;
  readonly bucket: SpaceGroupBucket;
  readonly label: GroupLabel;
  readonly collapsed: boolean;
  readonly top: number;
  readonly ariaRow: number;
  readonly grid: GridHandlers;
}) {
  return (
    <div role="row" aria-rowindex={ariaRow} className={ROW} style={{ top, height: GROUP_HEIGHT }}>
      <div role="gridcell" className={cn(STICKY, "h-full")}>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${label.text}`}
          className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => grid.toggleGroup(id)}
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
    </div>
  );
}

export function AddRow({
  group,
  top,
  ariaRow,
  store,
  grid,
}: {
  readonly group: SpaceGroupKey | null;
  readonly top: number;
  readonly ariaRow: number;
  readonly store: GridEditStore;
  readonly grid: GridHandlers;
}) {
  const adding = useAdding(store, group === null ? "" : canonicalJson(group));
  return (
    <div role="row" aria-rowindex={ariaRow} className={ROW} style={{ top, height: ROW_HEIGHT }}>
      <div role="gridcell" className={STICKY}>
        {adding ? (
          <Skeleton className="h-5 w-40" />
        ) : (
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => grid.addRow(group)}
          >
            <PlusIcon className="size-3.5" />
            New
          </button>
        )}
      </div>
    </div>
  );
}

export function MoreRow({
  group,
  loading,
  top,
  ariaRow,
  grid,
}: {
  readonly group: SpaceGroupKey;
  readonly loading: boolean;
  readonly top: number;
  readonly ariaRow: number;
  readonly grid: GridHandlers;
}) {
  return (
    <div role="row" aria-rowindex={ariaRow} className={ROW} style={{ top, height: ROW_HEIGHT }}>
      <div role="gridcell" className={STICKY}>
        {loading ? (
          <Skeleton className="h-5 w-40" />
        ) : (
          <button
            type="button"
            className="h-6 rounded-sm px-1.5 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => grid.loadBucket(group)}
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

export function SkeletonRow({ top, ariaRow }: { readonly top: number; readonly ariaRow: number }) {
  return (
    <div role="row" aria-rowindex={ariaRow} className={ROW} style={{ top, height: ROW_HEIGHT }}>
      <div role="gridcell" className={STICKY}>
        <Skeleton className="h-4 w-56" />
      </div>
    </div>
  );
}

const indentOf = (depth: number) => Math.min(depth, MAX_TREE_DEPTH) * INDENT;

/** `+ New sub-item` at the end of an expanded parent's children. */
export function AddChildRow({
  parentId,
  depth,
  top,
  ariaRow,
  grid,
}: {
  readonly parentId: string;
  readonly depth: number;
  readonly top: number;
  readonly ariaRow: number;
  readonly grid: GridHandlers;
}) {
  return (
    <div role="row" aria-rowindex={ariaRow} className={ROW} style={{ top, height: ROW_HEIGHT }}>
      <div role="gridcell" className={STICKY} style={{ paddingInlineStart: 8 + indentOf(depth) }}>
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => grid.addSubItem(parentId)}
        >
          <PlusIcon className="size-3.5" />
          New sub-item
        </button>
      </div>
    </div>
  );
}

export function MoreChildrenRow({
  parentId,
  depth,
  loading,
  top,
  ariaRow,
  grid,
}: {
  readonly parentId: string;
  readonly depth: number;
  readonly loading: boolean;
  readonly top: number;
  readonly ariaRow: number;
  readonly grid: GridHandlers;
}) {
  return (
    <div role="row" aria-rowindex={ariaRow} className={ROW} style={{ top, height: ROW_HEIGHT }}>
      <div role="gridcell" className={STICKY} style={{ paddingInlineStart: 8 + indentOf(depth) }}>
        {loading ? (
          <Skeleton className="h-5 w-40" />
        ) : (
          <button
            type="button"
            className="h-6 rounded-sm px-1.5 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => grid.loadChildren(parentId)}
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
