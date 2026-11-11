import { useAtomValue } from "@effect/atom-react";
import { formulaSchemaOf, relationTargetIds } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDataSource, SpaceDatabaseId } from "@t2code/contracts/spaces";
import type { FormulaSchema } from "@t2code/shared/formula";
import { AsyncResult, Atom } from "effect/reactivity";

import { useDataSourceHomes } from "../data/useDataSourceHomes";
import { databasePorts } from "../data/ports";
import { useDatabase } from "../shell/context";

interface Target {
  readonly dataSourceId: string;
  readonly databaseId: SpaceDatabaseId;
}

const MAX_LOADED_ATOMS = 32;
/** Least recently used last; bounded so editors opened over a long session do not accumulate. */
const loadedAtoms = new Map<string, ReturnType<typeof makeLoadedAtom>>();

function makeLoadedAtom(environmentId: EnvironmentId, targets: ReadonlyArray<Target>) {
  return Atom.make((get) =>
    targets.map((target) => {
      const result = get(databasePorts.databaseAtom(environmentId, target.databaseId));
      return {
        dataSourceId: target.dataSourceId,
        data: AsyncResult.getOrElse(result, () => null),
        settled: result._tag !== "Initial" || !result.waiting,
      };
    }),
  );
}

/** One atom per (environment, targets), so the subscription is stable across renders. */
function loadedAtom(environmentId: EnvironmentId, targets: ReadonlyArray<Target>, key: string) {
  const id = `${environmentId}|${key}`;
  const kept = loadedAtoms.get(id);
  const atom = kept ?? makeLoadedAtom(environmentId, targets);
  loadedAtoms.delete(id);
  loadedAtoms.set(id, atom);
  for (const oldest of loadedAtoms.keys()) {
    if (loadedAtoms.size <= MAX_LOADED_ATOMS) break;
    loadedAtoms.delete(oldest);
  }
  return atom;
}

/**
 * The checking schema of a data source, with the data sources its relations point at. Relation
 * targets in another database load through the database atom; `loading` stays true until every
 * one has answered (or failed), so a formula that reads across a relation is not judged early.
 */
export function useFormulaSchema(dataSource: SpaceDataSource): {
  readonly schema: FormulaSchema;
  readonly loading: boolean;
  /** A loaded data source: this database's, or a relation target's. */
  readonly sourceOf: (dataSourceId: string) => SpaceDataSource | undefined;
} {
  const { model } = useDatabase();
  const own = model.dataSources;
  const targetIds = relationTargetIds(dataSource).filter(
    (id) => !own.some((source) => source.id === id),
  );
  const { homes, resolving } = useDataSourceHomes(
    model.environmentId,
    model.database.spaceId,
    targetIds,
  );
  const targets = targetIds.flatMap((id): Target[] => {
    const home = homes.get(id);
    return home === undefined
      ? []
      : [{ dataSourceId: id, databaseId: home.databaseId as SpaceDatabaseId }];
  });
  const targetKey = targets
    .map((target) => `${target.dataSourceId}:${target.databaseId}`)
    .join(",");
  const environmentId = model.environmentId;
  const loaded = useAtomValue(loadedAtom(environmentId, targets, targetKey));
  const loading = resolving || loaded.some((entry) => !entry.settled);
  const databaseTitle = model.database.title;
  const { schema, sourceOf } = (() => {
    const sources = new Map<string, SpaceDataSource>();
    for (const source of own) sources.set(source.id, source);
    const names = new Map<string, string>();
    for (const entry of loaded)
      for (const source of entry.data?.dataSources ?? []) {
        sources.set(source.id, source);
        names.set(source.id, entry.data?.database.title.trim() || "Untitled");
      }
    const lookup = (id: string) => sources.get(id);
    return {
      sourceOf: lookup,
      schema: formulaSchemaOf(
        dataSource,
        lookup,
        (id) => names.get(id) ?? (own.some((s) => s.id === id) ? databaseTitle : undefined),
      ),
    };
  })();
  return { schema, loading, sourceOf };
}
