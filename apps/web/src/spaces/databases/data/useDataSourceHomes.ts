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
  /** The search finished and a missing id really is absent (not a failed read or the walk cap). */
  readonly complete: boolean;
  /** A read failed or the walk was capped: ids not found are unknown. */
  readonly incomplete: boolean;
  retry(): void;
} {
  const registry = useContext(RegistryContext);
  const list = useEnvironmentQuery(
    environmentId === undefined || spaceId === undefined || ids.length === 0
      ? null
      : databasePorts.listAtom(environmentId, spaceId),
  );
  const first = list.data;
  // The list's identity, not its object: a refetch that changed nothing does not walk again.
  const listKey = (first?.items ?? [])
    .map((item) => `${item.database.id}:${item.database.revision}:${item.dataSources.length}`)
    .join(",");
  const [attempt, setAttempt] = useState(0);
  const key = `${environmentId ?? ""}|${spaceId ?? ""}|${ids.join(",")}|${listKey}|${attempt}`;
  const [settled, setSettled] = useState<{
    readonly key: string;
    readonly homes: ReadonlyMap<string, DataSourceHome> | null;
    readonly incomplete: boolean;
  } | null>(null);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Pages the server's database list for relation targets; external data, asked again only when the wanted ids, the list's databases or a retry change.
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
        if (live) setSettled({ key, homes: found.homes, incomplete: found.incomplete });
      },
      () => {
        if (live) setSettled({ key, homes: null, incomplete: true });
      },
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `key` stands for `ids` and the list, which are new objects every render.
  }, [registry, environmentId, spaceId, key]);
  const retry = () => setAttempt((value) => value + 1);
  if (ids.length === 0)
    return { homes: NONE, resolving: false, complete: true, incomplete: false, retry };
  const done = settled?.key === key;
  const stuck = first === null && !list.isPending;
  return {
    homes: (done ? settled.homes : null) ?? NONE,
    resolving: !done && !stuck,
    complete: done && settled.homes !== null && !settled.incomplete,
    incomplete: done && settled.incomplete,
    retry,
  };
}
