import { createContext, useContext } from "react";
import type { ViewColumn } from "@t2code/client-runtime/spaces";
import type {
  SpaceBlockId,
  SpaceDataSource,
  SpaceDatabaseColor,
  SpaceDatabaseView,
  SpaceKnownDatabaseView,
  SpacePropertyId,
} from "@t2code/contracts/spaces";

import type { DatabaseActions } from "../data/actions";
import type { DatabaseModel } from "../data/useDatabaseModel";
import type { DatabaseLayout } from "../blocks/DatabaseBlockHost";

export type OpenControl = "filter" | "sort" | "group" | "properties" | null;

export interface DatabaseContextValue {
  readonly model: DatabaseModel;
  /** Of the active view. */
  readonly dataSource: SpaceDataSource;
  /** Effective (optimistic) active view. */
  readonly view: SpaceDatabaseView;
  readonly known: SpaceKnownDatabaseView | null;
  readonly columns: ReadonlyArray<ViewColumn>;
  readonly layout: DatabaseLayout;
  readonly blockId: SpaceBlockId;
  optionHint(
    propertyId: SpacePropertyId | string,
    optionId: string,
  ): { readonly name: string; readonly color: SpaceDatabaseColor | string } | undefined;
}

export const DatabaseContext = createContext<DatabaseContextValue | null>(null);
export const DatabaseActionsContext = createContext<DatabaseActions | null>(null);
export const OpenControlContext = createContext<
  readonly [OpenControl, (next: OpenControl) => void] | null
>(null);

/** Changes on every schema or view edit: cells and rows take props instead of calling this. */
export function useDatabase(): DatabaseContextValue {
  const value = useContext(DatabaseContext);
  if (value === null) throw new Error("useDatabase needs a database surface");
  return value;
}

/** Null outside a view surface, for example on a row page. */
export const useOptionalDatabase = () => useContext(DatabaseContext);

export function useDatabaseActions(): DatabaseActions {
  const value = useContext(DatabaseActionsContext);
  if (value === null) throw new Error("useDatabaseActions needs a database surface");
  return value;
}

export function useOpenControl(): readonly [OpenControl, (next: OpenControl) => void] {
  const value = useContext(OpenControlContext);
  if (value === null) throw new Error("useOpenControl needs a database surface");
  return value;
}
