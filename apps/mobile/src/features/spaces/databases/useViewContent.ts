import { viewDependencies, type CellTextContext } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDataSource, SpaceDatabaseView } from "@t2code/contracts/spaces";

import { viewerZone } from "../../../state/spacesDatabases";
import type { DatabaseModel } from "./useDatabaseModel";
import { useViewRows } from "./useViewRows";
import { formQueryInput, listItems, viewForm } from "./viewForms";

const noHint: CellTextContext["optionHint"] = () => undefined;

/** The form, the windowed rows and the flat list items of one saved view. */
export function useViewContent(args: {
  readonly environmentId: EnvironmentId;
  readonly model: DatabaseModel;
  readonly view: SpaceDatabaseView;
  readonly dataSource: SpaceDataSource;
  /** `YYYY-MM-01` of the month a calendar or timeline shows. */
  readonly month: string;
}) {
  const { environmentId, model, view, dataSource, month } = args;
  const zone = viewerZone();
  const form = viewForm(view, dataSource, model.limits);
  const input = formQueryInput(form, view, { environmentId, timeZone: zone, month });
  const watch =
    input === null
      ? null
      : viewDependencies(view, input.extraFilter, dataSource, input.properties ?? []);
  const rows = useViewRows(environmentId, dataSource.id, input, watch);
  const context: CellTextContext = {
    relatedPages: rows.relatedPages,
    optionHint: noHint,
    timeZone: zone,
  };
  const items = listItems(form, {
    dataSourceId: dataSource.id,
    rows: rows.rows,
    groups: rows.groups,
    hasMore: rows.hasMore,
    loadingMore: rows.loadingMore,
    bucketLoading: rows.bucketLoading,
    optionHint: noHint,
    zone,
    month,
  });
  return { form, rows, items, context };
}
