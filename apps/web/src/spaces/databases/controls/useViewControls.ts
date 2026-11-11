import type { SpaceKnownDatabaseView } from "@t2code/contracts/spaces";

import { useDatabase, useDatabaseActions } from "../shell/context";

/** What every control reads: the effective view as a known view, and whether it may be edited. */
export function useViewControls() {
  const { model, view, known, columns, dataSource } = useDatabase();
  const actions = useDatabaseActions();
  return {
    model,
    view,
    /** Null when this client cannot decode the view, in which case nothing edits it. */
    known: known as SpaceKnownDatabaseView | null,
    columns,
    dataSource,
    actions,
    limits: model.limits,
    canEditView: model.permissions.views && known !== null,
    canEditSchema: model.permissions.schema,
  };
}
