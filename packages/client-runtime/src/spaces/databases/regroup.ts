import type {
  SpaceCellValue,
  SpaceDatabaseRow,
  SpaceGroup,
  SpaceGroupBucket,
  SpaceGroupKey,
  SpaceKnownDatabaseProperty,
  SpaceKnownGroupBy,
  SpaceStatusGroup,
} from "@t2code/contracts/spaces";
import type { PendingCellEdits } from "./cellEdits.ts";
import { canonicalJson } from "./queryKey.ts";

/** Where a dropped card sits: before `beforeRowId` in the bucket `group`, or last when null. */
export interface RowPlacement {
  readonly group: SpaceGroupKey;
  readonly beforeRowId: string | null;
}

const EMPTY_KEY: SpaceGroupKey = { kind: "empty" };

/** The buckets a cell value belongs to; null when this grouping cannot be derived from the cell. */
function keysForValue(
  value: SpaceCellValue | null,
  known: SpaceKnownDatabaseProperty,
  by: SpaceKnownGroupBy | undefined,
): ReadonlyArray<SpaceGroupKey> | null {
  switch (known.type) {
    case "select":
    case "status": {
      if (typeof value !== "string") return [EMPTY_KEY];
      if (known.type === "status" && by === "status_group") {
        const group = known.config.options.find((option) => option.id === value)?.group;
        return group === undefined
          ? null
          : [{ kind: "status_group", group: group as SpaceStatusGroup }];
      }
      return [{ kind: "option", optionId: value }];
    }
    case "multi_select": {
      const ids = Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
      return ids.length === 0 ? [EMPTY_KEY] : ids.map((optionId) => ({ kind: "option", optionId }));
    }
    case "checkbox":
      return [{ kind: "checkbox", value: value === true }];
    default:
      return null;
  }
}

/**
 * Moves rows whose pending edit changes the group property into the bucket the new value maps to,
 * adjusting counts, then applies `placements`. Only option, status group and checkbox groupings are
 * derivable; every other grouping, and a group nobody edited, returns `groups` unchanged.
 */
export function regroupBuckets(
  groups: ReadonlyArray<SpaceGroupBucket>,
  pending: PendingCellEdits,
  known: SpaceKnownDatabaseProperty | null,
  by: SpaceKnownGroupBy | undefined,
  placements: Readonly<Record<string, RowPlacement>> = {},
): ReadonlyArray<SpaceGroupBucket> {
  let next: SpaceGroupBucket[] | null = null;
  const current = () => next ?? groups;
  const write = (index: number, bucket: SpaceGroupBucket) => {
    next ??= [...groups];
    next[index] = bucket;
  };
  const idOf = (bucket: SpaceGroupBucket) => canonicalJson(bucket.key);

  if (known !== null) {
    for (const edit of Object.values(pending)) {
      if (edit.propertyId !== known.id) continue;
      const target = keysForValue(edit.value, known, by);
      if (target === null) continue;
      const wanted = new Set(target.map(canonicalJson));
      const list = current();
      let source: SpaceDatabaseRow | undefined;
      for (const bucket of list) source ??= bucket.rows.find((row) => row.page.id === edit.pageId);
      if (source === undefined) continue;
      list.forEach((bucket, index) => {
        const has = bucket.rows.some((row) => row.page.id === edit.pageId);
        const belongs = wanted.has(idOf(bucket));
        if (has === belongs) return;
        write(
          index,
          belongs
            ? { ...bucket, rows: [...bucket.rows, source], count: bucket.count + 1 }
            : {
                ...bucket,
                rows: bucket.rows.filter((row) => row.page.id !== edit.pageId),
                count: Math.max(0, bucket.count - 1),
              },
        );
      });
    }
  }

  for (const [pageId, placement] of Object.entries(placements)) {
    const list = current();
    const id = canonicalJson(placement.group);
    const index = list.findIndex((bucket) => idOf(bucket) === id);
    const bucket = list[index];
    const row = bucket?.rows.find((entry) => entry.page.id === pageId);
    if (bucket === undefined || row === undefined) continue;
    const rest = bucket.rows.filter((entry) => entry !== row);
    const at =
      placement.beforeRowId === null
        ? -1
        : rest.findIndex((entry) => entry.page.id === placement.beforeRowId);
    const rows = at < 0 ? [...rest, row] : [...rest.slice(0, at), row, ...rest.slice(at)];
    if (rows.every((entry, position) => entry === bucket.rows[position])) continue;
    write(index, { ...bucket, rows });
  }
  return next ?? groups;
}

export interface OrderedBuckets {
  readonly shown: ReadonlyArray<SpaceGroupBucket>;
  readonly hidden: ReadonlyArray<SpaceGroupBucket>;
}

/**
 * Columns in display order: the empty bucket first, then `group.order` when the sort is manual.
 * Hidden groups are listed apart; empty buckets are dropped when `hideEmpty` is set.
 */
export function orderBuckets(
  groups: ReadonlyArray<SpaceGroupBucket>,
  group: Pick<SpaceGroup, "sort" | "order" | "hidden" | "hideEmpty"> | undefined,
): OrderedBuckets {
  const hiddenKeys = new Set((group?.hidden ?? []).map(canonicalJson));
  const hidden: SpaceGroupBucket[] = [];
  const visible: SpaceGroupBucket[] = [];
  for (const bucket of groups) {
    if (hiddenKeys.has(canonicalJson(bucket.key))) hidden.push(bucket);
    else if (group?.hideEmpty === true && bucket.count === 0) continue;
    else visible.push(bucket);
  }
  const rank = new Map((group?.order ?? []).map((key, index) => [canonicalJson(key), index]));
  const manual = group?.sort === "manual" && rank.size > 0;
  const position = (bucket: SpaceGroupBucket) =>
    bucket.key.kind === "empty"
      ? -1
      : manual
        ? (rank.get(canonicalJson(bucket.key)) ?? rank.size)
        : 0;
  const shown = visible
    .map((bucket, index) => ({ bucket, index }))
    .sort((a, b) => position(a.bucket) - position(b.bucket) || a.index - b.index)
    .map((entry) => entry.bucket);
  return { shown, hidden };
}

/**
 * The sub-group lanes of a grouped board: the union of every column's sub-group keys, ordered and
 * filtered as the sub-group setting says (manual order, hidden lanes, hide empty).
 */
export function laneKeys(
  buckets: ReadonlyArray<SpaceGroupBucket>,
  subGroup?: Pick<SpaceGroup, "sort" | "order" | "hidden" | "hideEmpty">,
): ReadonlyArray<SpaceGroupKey> {
  const lanes = new Map<string, SpaceGroupBucket>();
  for (const bucket of buckets)
    for (const sub of bucket.subGroups ?? []) {
      const id = canonicalJson(sub.key);
      const known = lanes.get(id);
      lanes.set(
        id,
        known === undefined
          ? { key: sub.key, count: sub.count, rows: [], nextCursor: null }
          : { ...known, count: known.count + sub.count },
      );
    }
  return orderBuckets([...lanes.values()], subGroup).shown.map((lane) => lane.key);
}

/** One column's cell in a lane; undefined when the column has no rows for that lane. */
export function laneCell(
  bucket: SpaceGroupBucket,
  laneKey: SpaceGroupKey,
): NonNullable<SpaceGroupBucket["subGroups"]>[number] | undefined {
  const id = canonicalJson(laneKey);
  return bucket.subGroups?.find((sub) => canonicalJson(sub.key) === id);
}
