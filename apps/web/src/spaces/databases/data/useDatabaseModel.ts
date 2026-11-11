import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceDataSource,
  SpaceDatabase,
  SpaceDatabaseId,
  SpaceDatabaseLimits,
  SpaceDatabaseView,
} from "@t2code/contracts/spaces";

import { useEnvironment } from "../../../state/environments";
import { useEnvironmentQuery } from "../../../state/query";
import { useSpacesAvailability } from "../../../state/spaces";
import { useDatabasePageEditable } from "../blocks/DatabaseBlockHost";
import { databaseErrorMessage } from "@t2code/client-runtime/spaces";
import { databasePorts } from "./ports";

export interface DatabasePermissions {
  readonly cells: boolean;
  readonly rows: boolean;
  readonly schema: boolean;
  readonly views: boolean;
  /** Renaming the database itself. */
  readonly title: boolean;
  /** Tab management and delete: the page itself must be editable. */
  readonly block: boolean;
}

export interface DatabaseModel {
  readonly environmentId: EnvironmentId;
  readonly database: SpaceDatabase;
  readonly dataSources: ReadonlyArray<SpaceDataSource>;
  /** Server views, not yet optimistic. */
  readonly views: ReadonlyArray<SpaceDatabaseView>;
  readonly limits: SpaceDatabaseLimits;
  readonly permissions: DatabasePermissions;
}

export function useDatabaseModel(environmentId: EnvironmentId, databaseId: SpaceDatabaseId) {
  const query = useEnvironmentQuery(databasePorts.databaseAtom(environmentId, databaseId));
  const availability = useSpacesAvailability(environmentId);
  const limits =
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities.spaces?.limits.databases;
  const pageEditable = useDatabasePageEditable();
  const cells = useAtomValue(databasePorts.permission.cells(environmentId));
  const rows = useAtomValue(databasePorts.permission.rows(environmentId));
  const schema = useAtomValue(databasePorts.permission.schema(environmentId));
  const views = useAtomValue(databasePorts.permission.views(environmentId));
  const title = useAtomValue(databasePorts.permission.rename(environmentId));
  const [kept, setKept] = useState(query.data);
  // A failed refetch answers with no data; the last success stays on screen with the error beside it.
  if (query.data && query.data !== kept) setKept(query.data);
  const data = query.data ?? kept;
  const writable = availability === "writable" && data?.database.live === true;
  const model: DatabaseModel | null =
    data && limits
      ? {
          environmentId,
          database: data.database,
          dataSources: data.dataSources,
          views: data.views,
          limits,
          permissions: {
            cells: writable && cells,
            rows: writable && rows,
            schema: writable && schema,
            views: writable && views,
            title: writable && title,
            block: writable && pageEditable,
          },
        }
      : null;
  return {
    model,
    isPending: query.isPending && model === null,
    error: query.error === null ? null : databaseErrorMessage(query.failure ?? query.error),
    refresh: query.refresh,
  };
}
