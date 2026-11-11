import { RegistryContext } from "@effect/atom-react";
import {
  applyCellPatches,
  queueCellEdit,
  type PendingCellEdit,
  type PendingCellEdits,
} from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import {
  SPACE_TITLE_PROPERTY_ID,
  type SpaceCellMap,
  type SpaceDatabaseRowGetResult,
  type SpacePageId,
} from "@t2code/contracts/spaces";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";

import { spacesEnvironment } from "../../../state/spaces";
import { databaseStores } from "../data/stores";

interface AckedEdit {
  readonly edit: PendingCellEdit;
  readonly dataRevision: number;
}

/**
 * The row's cells with this client's unsettled edits on top. The row query has no session, so an
 * acknowledged edit is kept until a row answer at or past its data revision arrives.
 */
export function useRowCells(
  environmentId: EnvironmentId,
  pageId: SpacePageId,
  data: SpaceDatabaseRowGetResult,
): SpaceCellMap {
  const registry = useContext(RegistryContext);
  const writer = databaseStores(registry).writer(environmentId);
  const { pending } = useSyncExternalStore(writer.subscribe, writer.getSnapshot);
  const [acked, setAcked] = useState<ReadonlyArray<AckedEdit>>([]);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- The writer is an external store; acknowledgements arrive outside React.
  useEffect(
    () =>
      writer.onAck((ack) => {
        const mine = ack.edits.filter((edit) => edit.pageId === pageId);
        if (mine.length === 0) return;
        // The title cell is the page title: refresh the page header and the library lists.
        if (mine.some((edit) => edit.propertyId === SPACE_TITLE_PROPERTY_ID))
          registry.update(spacesEnvironment.changed(environmentId), (value) => value + 1);
        setAcked((current) => [
          ...current,
          ...mine.map((edit) => ({ edit, dataRevision: ack.dataRevision })),
        ]);
      }),
    [writer, pageId, registry, environmentId],
  );
  const revision = data.dataSource.dataRevision;
  const live = acked.filter((entry) => entry.dataRevision > revision);
  if (live.length === 0 && Object.keys(pending).length === 0) return data.row.cells;
  const merged: PendingCellEdits = live.reduce(
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
