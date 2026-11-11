import { canonicalJson } from "@t2code/client-runtime/spaces";
import type {
  SpaceDatabaseRow,
  SpaceGroup,
  SpaceGroupBucket,
  SpaceGroupKey,
} from "@t2code/contracts/spaces";

export const ROW_HEIGHT = 34;
export const GROUP_HEIGHT = 36;

/** Nested sub-item levels drawn: deeper rows stay at this indent. */
export const MAX_TREE_DEPTH = 16;
/** Row height of a table that wraps any visible column. */
export const WRAPPED_ROW_HEIGHT = 76;

export type GridItem =
  | {
      readonly kind: "row";
      readonly row: SpaceDatabaseRow;
      readonly group: SpaceGroupKey | null;
      /** Sub-item level; 0 for top-level rows and everything outside a tree. */
      readonly depth?: number;
      /** The row has sub-items (a toggle shows). */
      readonly expandable?: boolean;
      readonly expanded?: boolean;
    }
  | { readonly kind: "addChild"; readonly parentId: string; readonly depth: number }
  | {
      readonly kind: "moreChildren";
      readonly parentId: string;
      readonly depth: number;
      readonly loading: boolean;
    }
  | {
      readonly kind: "group";
      readonly id: string;
      readonly bucket: SpaceGroupBucket;
      readonly collapsed: boolean;
    }
  | { readonly kind: "aggregate"; readonly bucket: SpaceGroupBucket }
  | { readonly kind: "add"; readonly group: SpaceGroupKey | null }
  | { readonly kind: "more"; readonly group: SpaceGroupKey; readonly loading: boolean }
  | { readonly kind: "skeleton" };

export interface GridItemsInput {
  readonly rows: ReadonlyArray<SpaceDatabaseRow>;
  readonly groups: ReadonlyArray<SpaceGroupBucket> | null;
  /** `canonicalJson` of the collapsed group keys. */
  readonly collapsed: ReadonlySet<string>;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  /** Whether a row may be added at the end (rows mode) or in this bucket. */
  readonly canAdd: boolean | ((key: SpaceGroupKey) => boolean);
  readonly bucketLoading?: (key: SpaceGroupKey) => boolean;
  /** Height of a row item; table views that wrap cells use `WRAPPED_ROW_HEIGHT`. */
  readonly rowHeight?: number;
  /** A calculation line under each open group's rows (some column has an aggregate). */
  readonly groupAggregates?: boolean;
  /** Rows mode only: sub-items of expanded parents are listed under them. */
  readonly tree?: SubItemTreeInput;
}

export interface SubItemTreeInput {
  readonly children: ReadonlyMap<
    string,
    {
      readonly rows: ReadonlyArray<SpaceDatabaseRow>;
      readonly status: "loading" | "ready" | "error";
      readonly hasMore: boolean;
      readonly loadingMore: boolean;
    }
  >;
  readonly canAddChild: boolean;
}

export interface GridLayout {
  readonly rowHeight: number;
  readonly items: ReadonlyArray<GridItem>;
  /** `offsets[i]` is the top of item `i`. */
  readonly offsets: ReadonlyArray<number>;
  readonly total: number;
  /** Page ids of the rows that are on screen candidates, in order (collapsed groups excluded). */
  readonly rowIds: ReadonlyArray<string>;
  readonly itemIndexByRow: ReadonlyMap<string, number>;
}

const heightOf = (item: GridItem, rowHeight: number) =>
  item.kind === "group" ? GROUP_HEIGHT : item.kind === "row" ? rowHeight : ROW_HEIGHT;

function pushRows(
  items: GridItem[],
  rows: ReadonlyArray<SpaceDatabaseRow>,
  group: SpaceGroupKey | null,
  depth: number,
  tree: SubItemTreeInput | undefined,
  _parentId: string | null,
) {
  for (const row of rows) {
    const id = row.page.id;
    const children = tree?.children.get(id);
    items.push({
      kind: "row",
      row,
      group,
      depth,
      expandable: tree !== undefined && (row.childCount ?? 0) > 0,
      expanded: children !== undefined,
    });
    if (children === undefined) continue;
    if (depth < MAX_TREE_DEPTH) pushRows(items, children.rows, group, depth + 1, tree, id);
    if (children.status === "loading" && children.rows.length === 0)
      items.push({ kind: "skeleton" });
    if (children.hasMore || children.loadingMore)
      items.push({
        kind: "moreChildren",
        parentId: id,
        depth: depth + 1,
        loading: children.loadingMore,
      });
    if (tree!.canAddChild) items.push({ kind: "addChild", parentId: id, depth: depth + 1 });
  }
}

/** Groups the view hides, and empty ones when `hideEmpty` is set, do not render in the table. */
export function visibleBuckets(
  groups: ReadonlyArray<SpaceGroupBucket>,
  group: Pick<SpaceGroup, "hidden" | "hideEmpty"> | undefined,
): ReadonlyArray<SpaceGroupBucket> {
  if (group === undefined) return groups;
  const hidden = new Set((group.hidden ?? []).map((key) => canonicalJson(key)));
  return groups.filter(
    (bucket) =>
      !hidden.has(canonicalJson(bucket.key)) &&
      !(group.hideEmpty === true && bucket.count === 0 && bucket.key.kind !== "empty"),
  );
}

export function buildGridItems(input: GridItemsInput): GridLayout {
  const items: GridItem[] = [];
  const allowed = (key: SpaceGroupKey) =>
    typeof input.canAdd === "boolean" ? input.canAdd : input.canAdd(key);
  if (input.groups === null) {
    pushRows(items, input.rows, null, 0, input.tree, null);
    if (input.loadingMore || (input.hasMore && input.rows.length === 0)) {
      for (let index = 0; index < 3; index += 1) items.push({ kind: "skeleton" });
    }
    if (input.canAdd !== false) items.push({ kind: "add", group: null });
  } else {
    for (const bucket of input.groups) {
      const id = canonicalJson(bucket.key);
      const collapsed = input.collapsed.has(id);
      items.push({ kind: "group", id, bucket, collapsed });
      if (collapsed) continue;
      pushRows(items, bucket.rows, bucket.key, 0, undefined, null);
      if (bucket.rows.length < bucket.count)
        items.push({
          kind: "more",
          group: bucket.key,
          loading: input.bucketLoading?.(bucket.key) ?? false,
        });
      if (input.groupAggregates === true && (bucket.aggregates?.length ?? 0) > 0)
        items.push({ kind: "aggregate", bucket });
      if (allowed(bucket.key)) items.push({ kind: "add", group: bucket.key });
    }
  }
  const offsets: number[] = [];
  const rowIds: string[] = [];
  const itemIndexByRow = new Map<string, number>();
  const rowHeight = input.rowHeight ?? ROW_HEIGHT;
  let total = 0;
  items.forEach((item, index) => {
    offsets.push(total);
    total += heightOf(item, rowHeight);
    if (item.kind === "row") {
      rowIds.push(item.row.page.id);
      itemIndexByRow.set(item.row.page.id, index);
    }
  });
  return { rowHeight, items, offsets, total, rowIds, itemIndexByRow };
}
