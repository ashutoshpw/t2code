import { RegistryContext } from "@effect/atom-react";
import { findDataSourceHomes, type DataSourceHome } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceId } from "@t2code/contracts/spaces";
import { useContext, useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../../state/query";
import { databasePorts } from "./ports";

const NONE: ReadonlyMap<string, DataSourceHome> = new Map();

/**
 * The database each data source id lives in. The space's first list page answers most; the rest
 * is paged (bounded), then any space is tried, so a target past page one still resolves.
 * `resolving` stays true until every id is found or the search ran out.
 */
export function useDataSourceHomes(
  environmentId: EnvironmentId | undefined,
  spaceId: SpaceId | undefined,
  ids: ReadonlyArray<string>,
): {
  readonly homes: ReadonlyMap<string, DataSourceHome>;
  readonly resolving: boolean;
  /** The search finished and a missing id really is absent (not a failed read). */
  readonly complete: boolean;
} {
  const registry = useContext(RegistryContext);
  const list = useEnvironmentQuery(
    environmentId === undefined || spaceId === undefined || ids.length === 0
      ? null
      : databasePorts.listAtom(environmentId, spaceId),
  );
  const first = list.data;
  const key = ids.join(",");
  const [settled, setSettled] = useState<{
    readonly key: string;
    readonly homes: ReadonlyMap<string, DataSourceHome> | null;
  } | null>(null);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Pages the server's database list for relation targets; external data, asked again only when the wanted ids or the first page change.
  useEffect(() => {
    if (environmentId === undefined || ids.length === 0 || first === null) return;
    let live = true;
    void findDataSourceHomes({
      ids,
      first,
      listPage: (cursor, anySpace) =>
        databasePorts.listPage(registry, environmentId, anySpace ? undefined : spaceId, cursor),
    }).then(
      (found) => {
        if (live) setSettled({ key, homes: found.homes });
      },
      () => {
        if (live) setSettled({ key, homes: null });
      },
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `key` stands for `ids`, which is a new array every render.
  }, [registry, environmentId, spaceId, key, first]);
  if (ids.length === 0) return { homes: NONE, resolving: false, complete: true };
  const done = settled?.key === key;
  const stuck = first === null && !list.isPending;
  return {
    homes: (done ? settled.homes : null) ?? NONE,
    resolving: !done && !stuck,
    complete: done && settled.homes !== null,
  };
}
