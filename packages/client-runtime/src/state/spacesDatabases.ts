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
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { requestGuarded, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  EMPTY_REMOTE_CHANGES,
  foldRemote,
  makeKnownRevisions,
  markApplied,
  noteDatabaseRevision,
  noteDataSourceRevisions,
  pendingBumps,
  type KnownRevisions,
  type RemoteChanges,
} from "../spaces/databases/remoteChanges.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

type Registry = AtomRegistry.AtomRegistry;

const keyOf = (environmentId: EnvironmentId, id: string) => JSON.stringify([environmentId, id]);

const pushes = (capability: SpaceCapability | undefined) =>
  capability?.version === 2 &&
  capability.features?.databases === true &&
  capability.features.databaseChanges === true;

/** A burst of remote changes becomes one application of counter bumps. */
const REMOTE_APPLY_DELAY_MS = 300;
/** Past this a database's idle subscription is released; leaving a view and coming back keeps it. */
const CHANGES_IDLE_TTL_MS = 10_000;

/**
 * Database state per environment. Invalidation is per data source and per database: a cell write
 * refreshes the queries of its data source and nothing else (not page lists, not the library).
 * Another client's edits arrive through the server's change stream, which carries ids and
 * revisions only; the counters below are bumped when it announces a revision this client lacks.
 */
export function createSpacesDatabaseAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options?: {
    readonly capabilityAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<SpaceCapability | undefined>;
    /** One-shot timer; tests inject their own. */
    readonly schedule?: (run: () => void, delayMs: number) => () => void;
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

  // Per registry: two clients of one atom set must not share what each has seen.
  const knownByRegistry = new WeakMap<Registry, Map<EnvironmentId, KnownRevisions>>();
  const knownOf = (registry: Registry, environmentId: EnvironmentId) => {
    let byEnvironment = knownByRegistry.get(registry);
    if (byEnvironment === undefined) {
      byEnvironment = new Map();
      knownByRegistry.set(registry, byEnvironment);
    }
    let known = byEnvironment.get(environmentId);
    if (known === undefined) {
      known = makeKnownRevisions();
      byEnvironment.set(environmentId, known);
    }
    return known;
  };
  const learnDataSource = (
    registry: Registry,
    environmentId: EnvironmentId,
    id: SpaceDataSourceId,
    revisions: { readonly schemaRevision?: number; readonly dataRevision?: number },
  ) => noteDataSourceRevisions(knownOf(registry, environmentId), id, revisions);
  const learnDatabase = (
    registry: Registry,
    environmentId: EnvironmentId,
    id: SpaceDatabaseId,
    revision: number,
  ) => noteDatabaseRevision(knownOf(registry, environmentId), id, revision);

  const learnOwner = (
    registry: Registry,
    environmentId: EnvironmentId,
    dataSourceId: SpaceDataSourceId,
    revision: number,
  ) => {
    const owner = registry.get(databaseOfDataSource(keyOf(environmentId, dataSourceId)));
    if (owner !== undefined) learnDatabase(registry, environmentId, owner, revision);
  };

  const remoteChanges = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:spaces:databases:changes",
    tag: WS_METHODS.spacesDatabasesSubscribeChanges,
    idleTtlMs: CHANGES_IDLE_TTL_MS,
    transform: (stream) => stream.pipe(Stream.scan(() => EMPTY_REMOTE_CHANGES, foldRemote)),
  });
  const resyncCounter = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  const schedule =
    options?.schedule ??
    ((run: () => void, delayMs: number) => {
      // @effect-diagnostics-next-line globalTimers:off -- a one-shot debounce read by atoms, outside an Effect runtime.
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });
  // Mounted by whatever reads `liveTrigger`; it depends on the capability only, so a bump never rebuilds it.
  const changeSubscription = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      if (!pushes(options ? get(options.capabilityAtom(environmentId)) : undefined)) return;
      const registry = get.registry;
      const known = knownOf(registry, environmentId);
      let latest: RemoteChanges = EMPTY_REMOTE_CHANGES;
      let seenResyncs = 0;
      let resyncWanted = false;
      let cancel: (() => void) | undefined;
      const apply = () => {
        cancel = undefined;
        const bumps = pendingBumps(latest, known);
        markApplied(latest, known);
        for (const source of bumps.dataSources) {
          bump(registry, dataSourceChanged(environmentId, source.id));
          if (source.schema) bump(registry, databaseChanged(environmentId, source.databaseId));
        }
        for (const id of bumps.databases) bump(registry, databaseChanged(environmentId, id));
        if (bumps.list) bump(registry, listCounter(environmentId));
        if (resyncWanted) {
          resyncWanted = false;
          bump(registry, resyncCounter(environmentId));
        }
      };
      get.addFinalizer(() => cancel?.());
      get.subscribe(
        remoteChanges({ environmentId, input: { environmentId } }),
        (result) => {
          if (result._tag !== "Success") return;
          latest = result.value;
          if (latest.resyncs !== seenResyncs) {
            // A fresh stream restarts its count at zero; only a resync event asks for a refresh.
            seenResyncs = latest.resyncs;
            resyncWanted = resyncWanted || latest.resyncs > 0;
          }
          if (cancel !== undefined) return;
          const pending = pendingBumps(latest, known);
          if (resyncWanted || pending.dataSources.length > 0 || pending.databases.length > 0)
            cancel = schedule(apply, REMOTE_APPLY_DELAY_MS);
        },
        { immediate: true },
      );
    }),
  );
  /** Every query trigger adds this in: it mounts the change stream and moves on a resync. */
  const liveTrigger = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      get(changeSubscription(environmentId));
      return get(resyncCounter(environmentId));
    }),
  );
  const listTrigger = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(listCounter(environmentId)) + get(liveTrigger(environmentId))),
  );
  /** What a view session watches: its data source's counter, moved by remote changes and resyncs too. */
  const dataSourceLive = Atom.family((key: string) => {
    const [environmentId, dataSourceId] = JSON.parse(key) as [EnvironmentId, SpaceDataSourceId];
    return Atom.make(
      (get) =>
        get(dataSourceChanged(environmentId, dataSourceId)) + get(liveTrigger(environmentId)),
    );
  });
  const databaseTrigger = Atom.family((key: string) => {
    const [environmentId, databaseId] = JSON.parse(key) as [EnvironmentId, SpaceDatabaseId];
    return Atom.make(
      (get) => get(databaseChanged(environmentId, databaseId)) + get(liveTrigger(environmentId)),
    );
  });

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
        (viewId === null ? 0 : get(viewCounter(keyOf(environmentId, viewId)))) +
        get(liveTrigger(environmentId)),
    );
  });
  // A row refreshes with its own writes and, once its answer named the data source, with schema edits.
  const rowTrigger = Atom.family((key: string) => {
    const [environmentId] = JSON.parse(key) as [EnvironmentId, string];
    return Atom.make((get) => {
      const source = get(dataSourceOfRow(key));
      return (
        get(rowCounter(key)) +
        get(liveTrigger(environmentId)) +
        (source === undefined ? 0 : get(dataSourceChanged(environmentId, source)))
      );
    });
  });

  const queryOptions = { idleTtlMs: 0, staleTimeMs: 0 } as const;

  return {
    databaseChanged,
    dataSourceChanged,
    /** What the server's change stream announced, folded; the applier reads it, tests observe it. */
    remoteChanges,
    /** The server pushes changes, so views do not need to poll for another client's edits. */
    changesLive: (registry: Registry, environmentId: EnvironmentId) =>
      pushes(options ? registry.get(options.capabilityAtom(environmentId)) : undefined),
    dataSourceLive: (environmentId: EnvironmentId, dataSourceId: SpaceDataSourceId) =>
      dataSourceLive(keyOf(environmentId, dataSourceId)),
    admission,
    rowPageChanged,
    dataSourcesChanged: bumpDataSources,
    noteRowDataSource,

    list: createEnvironmentQueryAtomFamily(runtime, {
      ...queryOptions,
      label: "environment-data:spaces:databases:list",
      refreshTrigger: ({ environmentId }: { environmentId: EnvironmentId }) =>
        listTrigger(environmentId),
      execute: Effect.fn("SpacesDatabases.list")(function* (
        input: EnvironmentRpcInput<typeof WS_METHODS.spacesDatabasesList>,
      ) {
        const registry = yield* AtomRegistry.AtomRegistry;
        const result = yield* guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesList, input),
        );
        registry.set(admission(input.environmentId), result.mutationAdmission);
        for (const item of result.items)
          learnDatabase(registry, input.environmentId, item.database.id, item.database.revision);
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
      }) => databaseTrigger(keyOf(environmentId, input.databaseId)),
      execute: Effect.fn("SpacesDatabases.database")(function* (
        input: EnvironmentRpcInput<typeof WS_METHODS.spacesDatabasesGet>,
      ) {
        const registry = yield* AtomRegistry.AtomRegistry;
        const result = yield* guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesGet, input),
        );
        registry.set(admission(input.environmentId), result.mutationAdmission);
        learnDatabase(registry, input.environmentId, result.database.id, result.database.revision);
        for (const source of result.dataSources) {
          learnDataSource(registry, input.environmentId, source.id, source);
          registry.set(
            databaseOfDataSource(keyOf(input.environmentId, source.id)),
            result.database.id,
          );
        }
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
        const result = yield* guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesQuery, input),
        );
        learnDataSource(registry, input.environmentId, result.dataSourceId, result);
        return result;
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
        learnDataSource(registry, input.environmentId, result.dataSource.id, result.dataSource);
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
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          learnDatabase(registry, target.environmentId, target.input.databaseId, result.revision);
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
          learnDatabase(registry, target.environmentId, target.input.databaseId, result.revision);
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
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          learnDataSource(registry, target.environmentId, target.input.dataSourceId, result);
          learnOwner(registry, target.environmentId, target.input.dataSourceId, result.revision);
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
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          learnOwner(registry, target.environmentId, target.input.dataSourceId, result.revision);
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
          learnDataSource(registry, target.environmentId, target.input.dataSourceId, result);
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
            learnDatabase(registry, target.environmentId, owner, result.revision);
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
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          const owner = registry.get(
            databaseOfView(keyOf(target.environmentId, target.input.viewId)),
          );
          if (owner !== undefined)
            learnDatabase(registry, target.environmentId, owner, result.revision);
          bumpViewAndDatabase(registry, target.environmentId, target.input.viewId);
        }),
    }),
    deleteView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:deleteView",
      tag: WS_METHODS.spacesDatabasesViewsDelete,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesViewsDelete, input),
        ),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          const owner = registry.get(
            databaseOfView(keyOf(target.environmentId, target.input.viewId)),
          );
          if (owner !== undefined)
            learnDatabase(registry, target.environmentId, owner, result.revision);
          bumpViewAndDatabase(registry, target.environmentId, target.input.viewId);
        }),
    }),
    createRows: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:spaces:databases:createRows",
      tag: WS_METHODS.spacesDatabasesRowsCreate,
      execute: (input, registry) =>
        guard(registry, input.environmentId, () =>
          requestGuarded(WS_METHODS.spacesDatabasesRowsCreate, input),
        ),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          learnDataSource(registry, target.environmentId, target.input.dataSourceId, result);
          bumpDataSources(registry, target.environmentId, [
            target.input.dataSourceId,
            ...(result.affectedDataSourceIds ?? []),
          ]);
        }),
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
          learnDataSource(registry, target.environmentId, target.input.dataSourceId, result);
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
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          learnDataSource(registry, target.environmentId, target.input.dataSourceId, result);
          bumpDataSources(registry, target.environmentId, [target.input.dataSourceId]);
        }),
    }),
  };
}

export type SpacesDatabaseAtoms = ReturnType<typeof createSpacesDatabaseAtoms>;
