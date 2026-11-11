import type {
  SpaceCellValue,
  SpaceDataSourceId,
  SpaceDatabaseRow,
  SpacePageId,
  SpacePropertyId,
} from "@t2code/contracts/spaces";

/** A queued cell write. `null` clears the cell. */
export interface PendingCellEdit {
  readonly dataSourceId: SpaceDataSourceId;
  readonly pageId: SpacePageId;
  readonly propertyId: SpacePropertyId;
  readonly value: SpaceCellValue | null;
  /** Orders edits of one cell; the caller issues it, strictly increasing. */
  readonly seq: number;
}

/** At most one entry per cell: the newest edit wins, as it does on the server. */
export type PendingCellEdits = Readonly<Record<string, PendingCellEdit>>;

export const EMPTY_PENDING_CELL_EDITS: PendingCellEdits = {};

const cellKey = (edit: Pick<PendingCellEdit, "pageId" | "propertyId">) =>
  JSON.stringify([edit.pageId, edit.propertyId]);

export function queueCellEdit(pending: PendingCellEdits, edit: PendingCellEdit): PendingCellEdits {
  const key = cellKey(edit);
  const current = pending[key];
  return current !== undefined && current.seq > edit.seq ? pending : { ...pending, [key]: edit };
}

/** Overlays pending edits on query rows for display. Rows and cells without edits keep their identity. */
export function applyCellPatches(
  rows: ReadonlyArray<SpaceDatabaseRow>,
  pending: PendingCellEdits,
): ReadonlyArray<SpaceDatabaseRow> {
  const byPage = new Map<SpacePageId, PendingCellEdit[]>();
  for (const edit of Object.values(pending)) {
    const list = byPage.get(edit.pageId);
    if (list === undefined) byPage.set(edit.pageId, [edit]);
    else list.push(edit);
  }
  if (byPage.size === 0) return rows;
  return rows.map((row) => {
    const edits = byPage.get(row.page.id);
    if (edits === undefined) return row;
    const cells = { ...row.cells };
    for (const edit of edits) {
      if (edit.value === null) delete cells[edit.propertyId];
      else cells[edit.propertyId] = edit.value;
    }
    return { ...row, cells };
  });
}

export interface CellWriteBatch {
  readonly dataSourceId: SpaceDataSourceId;
  readonly rows: ReadonlyArray<{
    readonly pageId: SpacePageId;
    readonly cells: Readonly<Record<string, SpaceCellValue | null>>;
  }>;
  /** The edits this batch carries; hand them to `settleCellEdits` once the server acknowledges. */
  readonly edits: ReadonlyArray<PendingCellEdit>;
}

/**
 * Groups pending edits into `updateRows` inputs: one stream of batches per data source, each within
 * the row and cell limits. Whole rows move together so a row never splits across two receipts
 * unless it alone exceeds the cell limit.
 */
export function coalesceCellWrites(
  pending: PendingCellEdits,
  limits: { readonly maxRowsPerMutation: number; readonly maxCellsPerMutation: number },
): ReadonlyArray<CellWriteBatch> {
  const sources = new Map<SpaceDataSourceId, Map<SpacePageId, PendingCellEdit[]>>();
  for (const edit of Object.values(pending).sort((a, b) => a.seq - b.seq)) {
    let pages = sources.get(edit.dataSourceId);
    if (pages === undefined) sources.set(edit.dataSourceId, (pages = new Map()));
    const list = pages.get(edit.pageId);
    if (list === undefined) pages.set(edit.pageId, [edit]);
    else list.push(edit);
  }
  const batches: CellWriteBatch[] = [];
  for (const [dataSourceId, pages] of sources) {
    let rows: Array<{ pageId: SpacePageId; cells: Record<string, SpaceCellValue | null> }> = [];
    let edits: PendingCellEdit[] = [];
    const flush = () => {
      if (rows.length > 0) batches.push({ dataSourceId, rows, edits });
      rows = [];
      edits = [];
    };
    for (const [pageId, list] of pages) {
      for (let start = 0; start < list.length; start += limits.maxCellsPerMutation) {
        const part = list.slice(start, start + limits.maxCellsPerMutation);
        if (
          rows.length >= limits.maxRowsPerMutation ||
          edits.length + part.length > limits.maxCellsPerMutation
        )
          flush();
        rows.push({
          pageId,
          cells: Object.fromEntries(part.map((edit) => [edit.propertyId, edit.value])),
        });
        edits.push(...part);
      }
    }
    flush();
  }
  return batches;
}

/**
 * Removes the edits a batch carried. An edit made to the same cell while the batch was in flight
 * has a higher seq and stays queued, so it is written next instead of being lost.
 */
export function settleCellEdits(
  pending: PendingCellEdits,
  settled: ReadonlyArray<PendingCellEdit>,
): PendingCellEdits {
  let next: Record<string, PendingCellEdit> | undefined;
  for (const edit of settled) {
    const key = cellKey(edit);
    const current = (next ?? pending)[key];
    if (current !== undefined && current.seq <= edit.seq) {
      next ??= { ...pending };
      delete next[key];
    }
  }
  return next ?? pending;
}
