import {
  SpacesUnavailableError,
  type SpaceCapability,
  type SpaceDataSourceId,
  type SpaceDatabaseId,
  type SpaceDatabaseGetInput,
  type SpaceDatabaseQueryInput,
  type SpaceDatabaseRowGetInput,
  type SpaceMutationAdmission,
  type SpacePageId,
  type SpaceViewId,
} from "@t2code/contracts/spaces";
import { WS_METHODS, type EnvironmentId } from "@t2code/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { requestGuarded, type EnvironmentRpcInput } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "./runtime.ts";

type Registry = AtomRegistry.AtomRegistry;

const keyOf = (environmentId: EnvironmentId, id: string) => JSON.stringify([environmentId, id]);

/**
 * Database state per environment. Invalidation is per data source and per database: a cell write
 * refreshes the queries of its data source and nothing else (not page lists, not the library).
 * There is no push channel, so another client's edits arrive when a view refetches.
 */
export function createSpacesDatabaseAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options?: {
    readonly capabilityAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<SpaceCapability | undefined>;
  },
) {
  const counter = () => Atom.family((_key: string) => Atom.make(0));
  const listCounter = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  const databaseCounter = counter();
  const dataSourceCounter = counter();
  const viewCounter = counter();
  const rowCounter = counter();
  // Learned from answers: the commands for a data source or view do not carry their database.
  // Nothing subscribes to these, and the registry sweeps unmounted nodes, so they stay alive.
  const databaseOfDataSource = Atom.family((_key: string) =>
    Atom.make<SpaceDatabaseId | undefined>(undefined).pipe(Atom.keepAlive),
  );
  const databaseOfView = Atom.family((_key: string) =>
    Atom.make<SpaceDatabaseId | undefined>(undefined).pipe(Atom.keepAlive),
  );
  const dataSourceOfRow = Atom.family((_key: string) =>
    Atom.make<SpaceDataSourceId | undefined>(undefined).pipe(Atom.keepAlive),
  );

  // The newest admission any answer carried; mutation inputs take their receipt epoch from it.
  const admissionAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<SpaceMutationAdmission | undefined>(undefined).pipe(Atom.keepAlive),
  );
  const admission = (environmentId: EnvironmentId) => admissionAtom(environmentId);

  const databaseChanged = (environmentId: EnvironmentId, databaseId: SpaceDatabaseId) =>
    databaseCounter(keyOf(environmentId, databaseId));
  const dataSourceChanged = (environmentId: EnvironmentId, dataSourceId: SpaceDataSourceId) =>
    dataSourceCounter(keyOf(environmentId, dataSourceId));

  const bump = (registry: Registry, atom: Atom.Writable<number>) =>
    registry.set(atom, registry.get(atom) + 1);
  const bumpDataSources = (
    registry: Registry,
    environmentId: EnvironmentId,
    ids: ReadonlyArray<SpaceDataSourceId>,
  ) => {
    for (const id of new Set(ids)) bump(registry, dataSourceChanged(environmentId, id));
  };
  const bumpDatabaseOf = (
    registry: Registry,
    environmentId: EnvironmentId,
    dataSourceId: SpaceDataSourceId,
  ) => {
    const owner = registry.get(databaseOfDataSource(keyOf(environmentId, dataSourceId)));
    if (owner !== undefined) bump(registry, databaseChanged(environmentId, owner));
  };
  const bumpViewAndDatabase = (
    registry: Registry,
    environmentId: EnvironmentId,
    viewId: SpaceViewId,
  ) => {
    bump(registry, viewCounter(keyOf(environmentId, viewId)));
    const owner = registry.get(databaseOfView(keyOf(environmentId, viewId)));
    if (owner !== undefined) bump(registry, databaseChanged(environmentId, owner));
  };

  /** A row's page was edited outside the grid (title, icon, trash, restore): refresh its data source. */
  const rowPageChanged = (
    registry: Registry,
    environmentId: EnvironmentId,
    pageId: SpacePageId,
  ) => {
    bump(registry, rowCounter(keyOf(environmentId, pageId)));
    const source = registry.get(dataSourceOfRow(keyOf(environmentId, pageId)));
    if (source !== undefined) bump(registry, dataSourceChanged(environmentId, source));
  };

  /** The grid knows a row's data source before the row was ever opened as a page. */
  const noteRowDataSource = (
    registry: Registry,
    environmentId: EnvironmentId,
    pageId: SpacePageId,
    dataSourceId: SpaceDataSourceId,
  ) => registry.set(dataSourceOfRow(keyOf(environmentId, pageId)), dataSourceId);

  const available = (registry: Registry, environmentId: EnvironmentId) => {
    const capability = options ? registry.get(options.capabilityAtom(environmentId)) : undefined;
    return capability?.version === 2 && capability.features?.databases === true;
  };
  const guard = <A, Err, Req>(
    registry: Registry,
    environmentId: EnvironmentId,
    run: () => Effect.Effect<A, Err, Req>,
  ) =>
    Effect.suspend((): Effect.Effect<A, Err | SpacesUnavailableError, Req> =>
      available(registry, environmentId)
        ? run()
        : Effect.fail(new SpacesUnavailableError({ stage: "settings" })),
    );

  // A query refreshes when its data source changes, or when the view it runs through is edited.
  const queryTrigger = Atom.family((key: string) => {
    const [environmentId, dataSourceId, viewId] = JSON.parse(key) as [
      EnvironmentId,
      SpaceDataSourceId,
      SpaceViewId | null,
    ];
    return Atom.make(
      (get) =>
        get(dataSourceChanged(environmentId, dataSourceId)) +
        (viewId === null ? 0 : get(viewCounter(keyOf(environmentId, viewId)))),
    );
  });
  // A row refreshes with its own writes and, once its answer named the data source, with schema edits.
  const rowTrigger = Atom.family((key: string) => {
    const [environmentId] = JSON.parse(key) as [EnvironmentId, string];
    return Atom.make((get) => {
      const source = get(dataSourceOfRow(key));
      return (
        get(rowCounter(key)) +
        (source === undefined ? 0 : get(dataSourceChanged(environmentId, source)))
      );
    });
  });

  const queryOptions = { idleTtlMs: 0, staleTimeMs: 0 } as const;

  return {
    databaseChanged,
    dataSourceChanged,
    admission,
    rowPageChanged,
    dataSourcesChanged: bumpDataSources,
    noteRowDataSource,

    list: createEnvironmentQueryAtomFamily(runtime, {
      ...queryOptions,
      label: "environment-data:spaces:databases:list",
      refreshTrigger: ({ environmentId }: { environmentId: EnvironmentId }) =>
        listCounter(environmentId),
      execute: Effect.fn("SpacesDatabases.list")(function* (
        input: EnvironmentRpcInput<typeof WS_METHODS.spacesDatabasesList>,
      ) {
        const registry = yield* AtomRegistry.AtomRegistry;
        const result = yield* guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesList, input),
        );
        registry.set(admission(input.environmentId), result.mutationAdmission);
        for (const item of result.items)
          for (const source of item.dataSources)
            registry.set(
              databaseOfDataSource(keyOf(input.environmentId, source.id)),
              item.database.id,
            );
        return result;
      }),
    }),
    database: createEnvironmentQueryAtomFamily(runtime, {
      ...queryOptions,
      label: "environment-data:spaces:databases:database",
      refreshTrigger: ({
        environmentId,
        input,
      }: {
        environmentId: EnvironmentId;
        input: SpaceDatabaseGetInput;
      }) => databaseChanged(environmentId, input.databaseId),
      execute: Effect.fn("SpacesDatabases.database")(function* (
        input: EnvironmentRpcInput<typeof WS_METHODS.spacesDatabasesGet>,
      ) {
        const registry = yield* AtomRegistry.AtomRegistry;
        const result = yield* guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesGet, input),
        );
        registry.set(admission(input.environmentId), result.mutationAdmission);
        for (const source of result.dataSources)
          registry.set(
            databaseOfDataSource(keyOf(input.environmentId, source.id)),
            result.database.id,
          );
        for (const view of result.views)
          registry.set(databaseOfView(keyOf(input.environmentId, view.id)), result.database.id);
        return result;
      }),
    }),
    query: createEnvironmentQueryAtomFamily(runtime, {
      ...queryOptions,
      label: "environment-data:spaces:databases:query",
      refreshTrigger: ({
        environmentId,
        input,
      }: {
        environmentId: EnvironmentId;
        input: SpaceDatabaseQueryInput;
      }) => queryTrigger(JSON.stringify([environmentId, input.dataSourceId, input.viewId ?? null])),
      execute: Effect.fn("SpacesDatabases.query")(function* (
        input: EnvironmentRpcInput<typeof WS_METHODS.spacesDatabasesQuery>,
      ) {
        const registry = yield* AtomRegistry.AtomRegistry;
        return yield* guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesQuery, input),
        );
      }),
    }),
    row: createEnvironmentQueryAtomFamily(runtime, {
      ...queryOptions,
      label: "environment-data:spaces:databases:row",
      refreshTrigger: ({
        environmentId,
        input,
      }: {
        environmentId: EnvironmentId;
        input: SpaceDatabaseRowGetInput;
      }) => rowTrigger(keyOf(environmentId, input.pageId)),
      execute: Effect.fn("SpacesDatabases.row")(function* (
        input: EnvironmentRpcInput<typeof WS_METHODS.spacesDatabasesRowsGet>,
      ) {
        const registry = yield* AtomRegistry.AtomRegistry;
        const result = yield* guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesRowsGet, input),
        );
        registry.set(admission(input.environmentId), result.mutationAdmission);
        registry.set(
          dataSourceOfRow(keyOf(input.environmentId, input.pageId)),
          result.dataSource.id,
        );
        return result;
      }),
    }),

    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:create",
      tag: WS_METHODS.spacesDatabasesCreate,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesCreate, input),
        ),
      onSuccess: (target, registry) =>
        Effect.sync(() => bump(registry, listCounter(target.environmentId))),
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:update",
      tag: WS_METHODS.spacesDatabasesUpdate,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesUpdate, input),
        ),
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          bump(registry, databaseChanged(target.environmentId, target.input.databaseId));
          bump(registry, listCounter(target.environmentId));
        }),
    }),
    createDataSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:createDataSource",
      tag: WS_METHODS.spacesDatabasesDataSourcesCreate,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesDataSourcesCreate, input),
        ),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          registry.set(
            databaseOfDataSource(keyOf(target.environmentId, result.dataSourceId)),
            target.input.databaseId,
          );
          bump(registry, databaseChanged(target.environmentId, target.input.databaseId));
          bump(registry, listCounter(target.environmentId));
        }),
    }),
    updateDataSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:updateDataSource",
      tag: WS_METHODS.spacesDatabasesDataSourcesUpdate,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesDataSourcesUpdate, input),
        ),
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          bumpDataSources(registry, target.environmentId, [target.input.dataSourceId]);
          bumpDatabaseOf(registry, target.environmentId, target.input.dataSourceId);
          bump(registry, listCounter(target.environmentId));
        }),
    }),
    deleteDataSource: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:deleteDataSource",
      tag: WS_METHODS.spacesDatabasesDataSourcesDelete,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesDataSourcesDelete, input),
        ),
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          bumpDataSources(registry, target.environmentId, [target.input.dataSourceId]);
          bumpDatabaseOf(registry, target.environmentId, target.input.dataSourceId);
          bump(registry, listCounter(target.environmentId));
        }),
    }),
    updateSchema: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:updateSchema",
      tag: WS_METHODS.spacesDatabasesSchemaUpdate,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesSchemaUpdate, input),
        ),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          bumpDataSources(registry, target.environmentId, [
            target.input.dataSourceId,
            ...result.affectedDataSourceIds,
          ]);
          bumpDatabaseOf(registry, target.environmentId, target.input.dataSourceId);
        }),
    }),
    createView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:createView",
      tag: WS_METHODS.spacesDatabasesViewsCreate,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesViewsCreate, input),
        ),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          const owner = registry.get(
            databaseOfDataSource(keyOf(target.environmentId, target.input.dataSourceId)),
          );
          if (owner !== undefined) {
            registry.set(databaseOfView(keyOf(target.environmentId, result.viewId)), owner);
            bump(registry, databaseChanged(target.environmentId, owner));
          }
        }),
    }),
    updateView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:updateView",
      tag: WS_METHODS.spacesDatabasesViewsUpdate,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesViewsUpdate, input),
        ),
      onSuccess: (target, registry) =>
        Effect.sync(() => bumpViewAndDatabase(registry, target.environmentId, target.input.viewId)),
    }),
    deleteView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:deleteView",
      tag: WS_METHODS.spacesDatabasesViewsDelete,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesViewsDelete, input),
        ),
      onSuccess: (target, registry) =>
        Effect.sync(() => bumpViewAndDatabase(registry, target.environmentId, target.input.viewId)),
    }),
    createRows: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:createRows",
      tag: WS_METHODS.spacesDatabasesRowsCreate,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesRowsCreate, input),
        ),
      onSuccess: (target, registry, result) =>
        Effect.sync(() =>
          bumpDataSources(registry, target.environmentId, [
            target.input.dataSourceId,
            ...(result.affectedDataSourceIds ?? []),
          ]),
        ),
    }),
    updateRows: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:updateRows",
      tag: WS_METHODS.spacesDatabasesRowsUpdate,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesRowsUpdate, input),
        ),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          bumpDataSources(registry, target.environmentId, [
            target.input.dataSourceId,
            ...result.affectedDataSourceIds,
          ]);
          for (const row of target.input.rows)
            bump(registry, rowCounter(keyOf(target.environmentId, row.pageId)));
        }),
    }),
    moveRows: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:moveRows",
      tag: WS_METHODS.spacesDatabasesRowsMove,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesRowsMove, input),
        ),
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          bumpDataSources(registry, target.environmentId, [target.input.dataSourceId]),
        ),
    }),
  };
}

export type SpacesDatabaseAtoms = ReturnType<typeof createSpacesDatabaseAtoms>;
