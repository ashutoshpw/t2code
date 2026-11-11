import { patchRowCells, recordAck, type AckedEdit } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import {
  SPACE_TITLE_PROPERTY_ID,
  type SpaceCellMap,
  type SpaceDatabaseRow,
} from "@t2code/contracts/spaces";
import { useEffect, useState, useSyncExternalStore } from "react";

import { appAtomRegistry } from "../../../state/atom-registry";
import { spacesEnvironment } from "../../../state/spaces";
import { databaseWriter } from "../../../state/spacesDatabases";

/**
 * The row's cells with this client's unsettled edits on top. The row query has no session, so an
 * acknowledged edit is kept until a row answer at or past its data revision arrives.
 */
export function useRowCells(
  environmentId: EnvironmentId,
  row: SpaceDatabaseRow,
  dataRevision: number,
): SpaceCellMap {
  const writer = databaseWriter(environmentId);
  const pageId = row.page.id;
  const { pending } = useSyncExternalStore(writer.subscribe, writer.getSnapshot);
  const [acked, setAcked] = useState<ReadonlyArray<AckedEdit>>([]);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- The writer is an external store; acknowledgements arrive outside React.
  useEffect(
    () =>
      writer.onAck((ack) => {
        // The title cell is the page title: refresh the page header and the library lists.
        if (
          ack.edits.some(
            (edit) => edit.pageId === pageId && edit.propertyId === SPACE_TITLE_PROPERTY_ID,
          )
        )
          appAtomRegistry.update(spacesEnvironment.changed(environmentId), (value) => value + 1);
        setAcked((current) => recordAck(current, ack, pageId));
      }),
    [writer, pageId, environmentId],
  );
  return patchRowCells({ row, dataSource: { dataRevision } }, pending, acked);
}
