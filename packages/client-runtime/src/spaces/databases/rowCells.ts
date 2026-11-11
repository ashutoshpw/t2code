import type { SpaceCellMap, SpaceDatabaseRowGetResult } from "@t2code/contracts/spaces";
import {
  applyCellPatches,
  queueCellEdit,
  type PendingCellEdit,
  type PendingCellEdits,
} from "./cellEdits.ts";
import type { WriteAck } from "./writer.ts";

/** An edit the server acknowledged, kept until a row answer at or past its data revision arrives. */
export interface AckedEdit {
  readonly edit: PendingCellEdit;
  readonly dataRevision: number;
}

/** Adds the edits of one page that an acknowledgement carries; the same array when it has none. */
export function recordAck(
  acked: ReadonlyArray<AckedEdit>,
  ack: Pick<WriteAck, "edits" | "dataRevision">,
  pageId: PendingCellEdit["pageId"],
): ReadonlyArray<AckedEdit> {
  const mine = ack.edits.filter((edit) => edit.pageId === pageId);
  return mine.length === 0
    ? acked
    : [...acked, ...mine.map((edit) => ({ edit, dataRevision: ack.dataRevision }))];
}

/**
 * The row's cells with this client's unsettled edits on top: acknowledged edits the row answer
 * does not include yet, then the writer's pending edits. Keeps the row's own cells when neither
 * applies.
 */
export function patchRowCells(
  data: Pick<SpaceDatabaseRowGetResult, "row"> & {
    readonly dataSource: Pick<SpaceDatabaseRowGetResult["dataSource"], "dataRevision">;
  },
  pending: PendingCellEdits,
  acked: ReadonlyArray<AckedEdit>,
): SpaceCellMap {
  const pageId = data.row.page.id;
  const revision = data.dataSource.dataRevision;
  const live = acked.filter((entry) => entry.dataRevision > revision);
  if (live.length === 0 && Object.keys(pending).length === 0) return data.row.cells;
  const merged = live.reduce(
    (edits: PendingCellEdits, entry) => queueCellEdit(edits, entry.edit),
    {},
  );
  const patch = Object.values(pending).reduce(
    (edits: PendingCellEdits, edit) =>
      edit.pageId === pageId ? queueCellEdit(edits, edit) : edits,
    merged,
  );
  return applyCellPatches([data.row], patch)[0]?.cells ?? data.row.cells;
}
