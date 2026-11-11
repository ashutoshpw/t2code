import { RegistryContext } from "@effect/atom-react";
import { patchRowCells, recordAck, type AckedEdit } from "@t2code/client-runtime/spaces";
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
        // The title cell is the page title: refresh the page header and the library lists.
        if (
          ack.edits.some(
            (edit) => edit.pageId === pageId && edit.propertyId === SPACE_TITLE_PROPERTY_ID,
          )
        )
          registry.update(spacesEnvironment.changed(environmentId), (value) => value + 1);
        setAcked((current) => recordAck(current, ack, pageId));
      }),
    [writer, pageId, registry, environmentId],
  );
  return patchRowCells(data, pending, acked);
}
