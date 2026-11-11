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
  const loaded = windows?.rows ?? EMPTY_ROWS;
  const rows = applyCellPatches(
    mode === "rows" && placed.length > 0
      ? [...loaded, ...placed.map((entry) => entry.row)]
      : loaded,
    pending,
  );
  const groups =
    mode === "groups" && windows?.groups
      ? windows.groups.map((bucket) => {
          const id = canonicalJson(bucket.key);
          const extra = placed.filter((entry) => entry.group === id).map((entry) => entry.row);
          const patched = applyCellPatches(
            extra.length > 0 ? [...bucket.rows, ...extra] : bucket.rows,
            pending,
          );
          return patched === bucket.rows && extra.length === 0
            ? bucket
            : { ...bucket, rows: patched, count: bucket.count + extra.length };
        })
      : null;
  return { rows, groups, pending };
}
