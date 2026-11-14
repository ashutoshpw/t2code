import type { SpaceDataSourceId } from "@t2code/contracts/spaces";

import { useDataSourceHomes } from "../data/useDataSourceHomes";
import type { databasePorts } from "../data/ports";
import { useOptionalDatabase } from "../shell/context";

const NO_IDS: ReadonlyArray<string> = [];

/** The title of the database a relation points at, and whether it is known to be gone. */
export function useRelationTarget(
  environmentId: Parameters<typeof databasePorts.listAtom>[0] | undefined,
  spaceId: Parameters<typeof databasePorts.listAtom>[1] | undefined,
  dataSourceId: SpaceDataSourceId,
): { readonly title: string | null; readonly deleted: boolean } {
  const surface = useOptionalDatabase();
  const own = surface?.model.dataSources.find((source) => source.id === dataSourceId);
  const { homes, complete } = useDataSourceHomes(
    environmentId,
    spaceId,
    own === undefined ? [dataSourceId] : NO_IDS,
  );
  if (own !== undefined)
    return { title: surface?.model.database.title.trim() || "Untitled", deleted: false };
  const home = homes.get(dataSourceId);
  return {
    title: home?.title ?? null,
    deleted: home === undefined && complete && own === undefined,
  };
}
