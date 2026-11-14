import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDataSource, SpaceDatabaseView, SpacePageId } from "@t2code/contracts/spaces";
import { useState } from "react";

import { ControlPill } from "../../../components/ui/ControlPill";
import { emptyGroupHidden } from "./addRow";
import { NewRowSheet } from "./NewRowSheet";
import type { DatabaseModel } from "./useDatabaseModel";

/** "New row": offered only when this connection and grant can add rows to a live database. */
export function NewRowPill(props: {
  readonly environmentId: EnvironmentId;
  readonly model: DatabaseModel;
  readonly view: SpaceDatabaseView;
  readonly dataSource: SpaceDataSource;
  readonly month?: string;
  /** Refreshes the rows on screen once the new row exists. */
  readonly onCreated: () => void;
  /** Opens a row's page: used when the new row would land in a section that is not shown. */
  readonly onOpenPage: (pageId: SpacePageId) => void;
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
          {...(props.month === undefined ? {} : { month: props.month })}
          onCreated={(pageId) => {
            props.onCreated();
            if (pageId !== undefined && emptyGroupHidden(props.view)) props.onOpenPage(pageId);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
