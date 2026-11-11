import { canonicalJson } from "@t2code/client-runtime/spaces";
import type {
  SpaceDatabaseRow,
  SpaceGroup,
  SpaceGroupBucket,
  SpaceGroupKey,
} from "@t2code/contracts/spaces";

export const ROW_HEIGHT = 34;
export const GROUP_HEIGHT = 36;

export type GridItem =
  | { readonly kind: "row"; readonly row: SpaceDatabaseRow; readonly group: SpaceGroupKey | null }
  | {
      readonly kind: "group";
      readonly id: string;
      readonly bucket: SpaceGroupBucket;
      readonly collapsed: boolean;
    }
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
}

export interface GridLayout {
  readonly items: ReadonlyArray<GridItem>;
  /** `offsets[i]` is the top of item `i`. */
  readonly offsets: ReadonlyArray<number>;
  readonly total: number;
  /** Page ids of the rows that are on screen candidates, in order (collapsed groups excluded). */
  readonly rowIds: ReadonlyArray<string>;
  readonly itemIndexByRow: ReadonlyMap<string, number>;
}

const heightOf = (item: GridItem) => (item.kind === "group" ? GROUP_HEIGHT : ROW_HEIGHT);

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
    for (const row of input.rows) items.push({ kind: "row", row, group: null });
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
      for (const row of bucket.rows) items.push({ kind: "row", row, group: bucket.key });
      if (bucket.rows.length < bucket.count)
        items.push({
          kind: "more",
          group: bucket.key,
          loading: input.bucketLoading?.(bucket.key) ?? false,
        });
      if (allowed(bucket.key)) items.push({ kind: "add", group: bucket.key });
    }
  }
  const offsets: number[] = [];
  const rowIds: string[] = [];
  const itemIndexByRow = new Map<string, number>();
  let total = 0;
  items.forEach((item, index) => {
    offsets.push(total);
    total += heightOf(item);
    if (item.kind === "row") {
      rowIds.push(item.row.page.id);
      itemIndexByRow.set(item.row.page.id, index);
    }
  });
  return { items, offsets, total, rowIds, itemIndexByRow };
}
