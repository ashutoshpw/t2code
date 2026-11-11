import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceDataSource,
  SpaceDatabase,
  SpaceDatabaseId,
  SpaceDatabaseLimits,
  SpaceDatabaseView,
} from "@t2code/contracts/spaces";
import { useState } from "react";

import { useEnvironmentQuery } from "../../../state/query";
import { useSpacesReadAccess } from "../../../state/spaces";
import { databaseAtoms } from "../../../state/spacesDatabases";
import { databaseLimitsOf } from "./capability";

export interface DatabaseModel {
  readonly database: SpaceDatabase;
  readonly dataSources: ReadonlyArray<SpaceDataSource>;
  readonly views: ReadonlyArray<SpaceDatabaseView>;
  readonly limits: SpaceDatabaseLimits;
  readonly canEditCells: boolean;
  readonly canAddRows: boolean;
}

/** One database, its data sources and views; the last good answer stays while a refetch fails. */
export function useDatabaseModel(environmentId: EnvironmentId, databaseId: SpaceDatabaseId) {
  const access = useSpacesReadAccess(environmentId);
  const query = useEnvironmentQuery(
    databaseAtoms.database({ environmentId, input: { environmentId, databaseId } }),
  );
  const canUpdateRows = useAtomValue(databaseAtoms.updateRows.permissionAtom(environmentId));
  const canCreateRows = useAtomValue(databaseAtoms.createRows.permissionAtom(environmentId));
  const [kept, setKept] = useState(query.data);
  if (query.data && query.data !== kept) setKept(query.data);
  const data = query.data ?? kept;
  const limits = databaseLimitsOf(access.capability);
  const writable = access.availability === "writable" && data?.database.live === true;
  const model: DatabaseModel | null =
    data && limits
      ? {
          database: data.database,
          dataSources: data.dataSources,
          views: data.views,
          limits,
          canEditCells: writable && canUpdateRows,
          canAddRows: writable && canCreateRows,
        }
      : null;
  return {
    model,
    supported: limits !== null,
    isPending: query.isPending && model === null,
    error: query.error,
    refresh: query.refresh,
  };
}
