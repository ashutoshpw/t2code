import type {
  SpaceDataSourceId,
  SpaceDatabaseRow,
  SpaceGroupBucket,
} from "@t2code/contracts/spaces";

import { EMPTY_PENDING_CELL_EDITS, applyCellPatches, type PendingCellEdits } from "./cellEdits.ts";
import { canonicalJson } from "./queryKey.ts";
import type { QuerySnapshot } from "./querySession.ts";

const EMPTY_ROWS: ReadonlyArray<SpaceDatabaseRow> = [];

/**
 * What a view shows: the loaded rows (or buckets) with the writer's queued edits and the session's
 * acknowledged-but-not-yet-loaded edits applied, and rows created here placed in. Unchanged input
 * gives the same row objects back, so a keyed list re-renders only the rows an edit touched.
 */
export function deriveViewRows(input: {
  readonly mode: "rows" | "groups";
  readonly dataSourceId: SpaceDataSourceId;
  readonly snapshot: QuerySnapshot;
  /** The writer's pending edits, of any data source. */
  readonly writerPending: PendingCellEdits;
}): {
  readonly rows: ReadonlyArray<SpaceDatabaseRow>;
  readonly groups: ReadonlyArray<SpaceGroupBucket> | null;
  readonly pending: PendingCellEdits;
} {
  const { mode, dataSourceId, snapshot, writerPending } = input;
  const queued = Object.values(writerPending);
  const own = queued.some((edit) => edit.dataSourceId === dataSourceId)
    ? Object.fromEntries(
        Object.entries(writerPending).filter(([, edit]) => edit.dataSourceId === dataSourceId),
      )
    : EMPTY_PENDING_CELL_EDITS;
  // Acknowledged edits the loaded rows do not hold yet sit under the newer queued ones.
  const pending = Object.keys(snapshot.acked).length > 0 ? { ...snapshot.acked, ...own } : own;
  const windows = snapshot.windows;
  const placed = snapshot.placed;
  // Ungrouping keeps the old answer until the flat one arrives: show its rows, not a skeleton.
  const loaded =
    mode === "rows" && windows?.groups !== undefined
      ? windows.groups.flatMap((bucket) =>
          bucket.subGroups === undefined
            ? bucket.rows
            : bucket.subGroups.flatMap((sub) => sub.rows),
        )
      : (windows?.rows ?? EMPTY_ROWS);
  const heldIds = new Set(loaded.map((row) => row.page.id));
  const rows = applyCellPatches(
    mode === "rows" && placed.length > 0
      ? [...loaded, ...placed.map((entry) => entry.row).filter((row) => !heldIds.has(row.page.id))]
      : loaded,
    pending,
  );
  const groups =
    mode === "groups" && windows?.groups
      ? windows.groups.map((bucket) => {
          const id = canonicalJson(bucket.key);
          const held = new Set(bucket.rows.map((row) => row.page.id));
          const mine = placed.filter((entry) => entry.group === id && !held.has(entry.row.page.id));
          const extra = mine.map((entry) => entry.row);
          const uncounted = mine.filter((entry) => entry.counted !== true).length;
          const patched = applyCellPatches(
            extra.length > 0 ? [...bucket.rows, ...extra] : bucket.rows,
            pending,
          );
          return patched === bucket.rows && extra.length === 0
            ? bucket
            : { ...bucket, rows: patched, count: bucket.count + uncounted };
        })
      : null;
  return { rows, groups, pending };
}
