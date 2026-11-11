import { PlusIcon } from "lucide-react";
import type { SpaceGroupKey, SpacePageId } from "@t2code/contracts/spaces";

import { Skeleton } from "~/components/ui/skeleton";
import type { RowListHandlers } from "./useRowList";
import { MAX_TREE_DEPTH } from "../table/gridItems";
import { INDENT } from "../table/tree";
import { LIST_ROW_HEIGHT } from "./listLayout";

const BUTTON =
  "inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** `+ New` at the end of the list or of a group. */
export function AddLine({
  index,
  top,
  group,
  adding,
  handlers,
}: {
  readonly index: number;
  readonly top: number;
  readonly group: SpaceGroupKey | null;
  readonly adding: boolean;
  readonly handlers: RowListHandlers;
}) {
  return (
    <div
      role="listitem"
      data-item-index={index}
      className="absolute inset-x-0 flex items-center px-3"
      style={{ top, height: LIST_ROW_HEIGHT }}
    >
      {adding ? (
        <Skeleton className="h-5 w-40" />
      ) : (
        <button type="button" data-nav="" className={BUTTON} onClick={() => handlers.add(group)}>
          <PlusIcon className="size-3.5" />
          New
        </button>
      )}
    </div>
  );
}

/** `Load more` under a bucket that has rows left. */
export function MoreLine({
  index,
  top,
  group,
  loading,
  handlers,
}: {
  readonly index: number;
  readonly top: number;
  readonly group: SpaceGroupKey;
  readonly loading: boolean;
  readonly handlers: RowListHandlers;
}) {
  return (
    <div
      role="listitem"
      data-item-index={index}
      className="absolute inset-x-0 flex items-center px-3"
      style={{ top, height: LIST_ROW_HEIGHT }}
    >
      {loading ? (
        <Skeleton className="h-5 w-40" />
      ) : (
        <button
          type="button"
          data-nav=""
          className={BUTTON}
          onClick={() => handlers.loadBucket(group)}
        >
          Load more
        </button>
      )}
    </div>
  );
}

export function SkeletonLine({ index, top }: { readonly index: number; readonly top: number }) {
  return (
    <div
      role="presentation"
      data-item-index={index}
      className="absolute inset-x-0 flex items-center px-3"
      style={{ top, height: LIST_ROW_HEIGHT }}
    >
      <Skeleton className="h-5 w-full" />
    </div>
  );
}

const childPadding = (depth: number) => 6 + Math.min(depth, MAX_TREE_DEPTH) * INDENT;

/** `+ New sub-item` under an expanded parent's children. */
export function AddChildLine({
  index,
  top,
  parentId,
  depth,
  handlers,
}: {
  readonly index: number;
  readonly top: number;
  readonly parentId: SpacePageId;
  readonly depth: number;
  readonly handlers: RowListHandlers;
}) {
  return (
    <div
      role="listitem"
      data-item-index={index}
      className="absolute inset-x-0 flex items-center px-3"
      style={{ top, height: LIST_ROW_HEIGHT, paddingInlineStart: childPadding(depth) + 12 }}
    >
      <button
        type="button"
        data-nav=""
        className={BUTTON}
        onClick={() => handlers.addSubItem(parentId)}
      >
        <PlusIcon className="size-3.5" />
        New sub-item
      </button>
    </div>
  );
}

export function MoreChildrenLine({
  index,
  top,
  parentId,
  depth,
  loading,
  handlers,
}: {
  readonly index: number;
  readonly top: number;
  readonly parentId: SpacePageId;
  readonly depth: number;
  readonly loading: boolean;
  readonly handlers: RowListHandlers;
}) {
  return (
    <div
      role="listitem"
      data-item-index={index}
      className="absolute inset-x-0 flex items-center px-3"
      style={{ top, height: LIST_ROW_HEIGHT, paddingInlineStart: childPadding(depth) + 12 }}
    >
      {loading ? (
        <Skeleton className="h-5 w-40" />
      ) : (
        <button
          type="button"
          data-nav=""
          className={BUTTON}
          onClick={() => handlers.loadChildren(parentId)}
        >
          Load more
        </button>
      )}
    </div>
  );
}
