import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDataSource, SpaceDatabaseView } from "@t2code/contracts/spaces";
import { useState } from "react";

import { ControlPill } from "../../../components/ui/ControlPill";
import { NewRowSheet } from "./NewRowSheet";
import type { DatabaseModel } from "./useDatabaseModel";

/** "New row": offered only when this connection and grant can add rows to a live database. */
export function NewRowPill(props: {
  readonly environmentId: EnvironmentId;
  readonly model: DatabaseModel;
  readonly view: SpaceDatabaseView;
  readonly dataSource: SpaceDataSource;
  /** Refreshes the rows on screen once the new row exists. */
  readonly onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!props.model.canAddRows) return null;
  return (
    <>
      <ControlPill variant="pill" label="New row" icon="plus" onPress={() => setOpen(true)} />
      {open ? (
        <NewRowSheet
          environmentId={props.environmentId}
          view={props.view}
          dataSource={props.dataSource}
          onCreated={props.onCreated}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
