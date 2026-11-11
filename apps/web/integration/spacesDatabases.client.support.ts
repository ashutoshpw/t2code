import {
  DatabaseQuerySession,
  EMPTY_PENDING_CELL_EDITS,
  ackViewEdit,
  applyCellPatches,
  canonicalJson,
  dropViewEdit,
  effectiveView,
  queueViewEdit,
  resolveBlockViews,
  viewColumns,
  viewDependencies,
  type DatabaseWriter,
  type PendingCellEdits,
  type ViewEdits,
  type ViewPatch,
} from "@t2code/client-runtime/spaces";
import { executeAtomQuery } from "@t2code/client-runtime/state/runtime";
import * as C from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import {
  createDatabaseActions,
  type DatabaseActions,
} from "../src/spaces/databases/data/actions.ts";
import { databasePorts } from "../src/spaces/databases/data/ports.ts";
import { databaseStores } from "../src/spaces/databases/data/stores.ts";
import type { DatabaseModel } from "../src/spaces/databases/data/useDatabaseModel.ts";
import { connectViewSession } from "../src/spaces/databases/data/viewSession.ts";
import { viewInputOf, type ViewQueryOptions } from "../src/spaces/databases/data/useViewQuery.ts";
import { placeDatabaseBlock } from "./spacesDatabases.support.ts";
import {
  type DatabasesWorld,
  OPERATE_SESSION,
  READ_ONLY_SESSION,
  environmentId,
  sessionStates,
} from "./spacesDatabases.standin.support.ts";

/** Creates a database as the app does: the block goes on the page, which makes it live. */
export async function createLiveDatabase(
  world: DatabasesWorld,
  registry: AtomRegistry.AtomRegistry,
  title: string,
) {
  const created = await databasePorts.run.create(registry, environmentId, {
    spaceId: world.spaceId,
    title,
  });
  await Effect.runPromise(placeDatabaseBlock(world, created.databaseId, [created.viewId]));
  return created;
}

/** A browser tab: its own atom registry, so its caches and writer are its own. */
export function browser(options: { readonly readOnly?: boolean } = {}) {
  const registry = AtomRegistry.make();
  registry.mount(sessionStates(environmentId));
  registry.set(
    sessionStates(environmentId),
    AsyncResult.success(options.readOnly === true ? READ_ONLY_SESSION : OPERATE_SESSION),
  );
  return registry;
}

const unwrap = <A, E>(result: AsyncResult.AsyncResult<A, E>): A => {
  if (result._tag === "Success") return result.value;
  throw result._tag === "Failure" ? Cause.squash(result.cause) : new Error("Query did not settle");
};

/** Runs on the schedule a view session asks for; nothing waits on a timer. */
function manualClock() {
  const tasks = new Set<() => void>();
  const watchers = new Set<() => void>();
  return {
    schedule: (run: () => void) => {
      tasks.add(run);
      for (const watcher of watchers) queueMicrotask(watcher);
      return () => {
        tasks.delete(run);
      };
    },
    pending: () => tasks.size,
    tick: () => {
      const due = [...tasks];
      tasks.clear();
      for (const run of due) run();
    },
    watch: (watcher: () => void) => {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
  };
}

/**
 * One view as a client holds it: the real session and writer wired as `useViewQuery` wires them,
 * with rows derived the same way (loaded windows, placed rows, pending and acked edits).
 */
function openViewQuery(
  registry: AtomRegistry.AtomRegistry,
  writer: DatabaseWriter,
  model: DatabaseModel,
  view: C.SpaceDatabaseView,
  options: Partial<ViewQueryOptions> & { readonly fillRows?: number } = {},
) {
  const dataSource = model.dataSources.find((source) => source.id === view.dataSourceId)!;
  const clock = manualClock();
  const session = new DatabaseQuerySession({
    query: (input) => databasePorts.query(registry, input),
    schedule: clock.schedule,
    busy: () => writer.busy(dataSource.id),
  });
  const mode = options.mode ?? "rows";
  const viewOptions: ViewQueryOptions = { mode, search: "", ...options };
  const columns = viewColumns(view, dataSource);
  let input = viewInputOf(model, view, columns, viewOptions);
  const dependenciesOf = (of: C.SpaceDatabaseView) =>
    viewDependencies(
      of,
      options.extraFilter,
      dataSource,
      viewColumns(of, dataSource)
        .filter((column) => column.visible)
        .map((column) => column.property.id),
    );
  let dependencies = dependenciesOf(view);
  const disconnect = connectViewSession({
    session,
    registry,
    environmentId,
    dataSourceId: dataSource.id,
    writer,
    watched: () => dependencies,
  });
  session.setInput(input, { fillRows: options.fillRows ?? 0 });

  const pending = (): PendingCellEdits => {
    const written = writer.getSnapshot().pending;
    const own = Object.values(written).some((edit) => edit.dataSourceId === dataSource.id)
      ? Object.fromEntries(
          Object.entries(written).filter(([, edit]) => edit.dataSourceId === dataSource.id),
        )
      : EMPTY_PENDING_CELL_EDITS;
    const acked = session.getSnapshot().acked;
    return Object.keys(acked).length > 0 ? { ...acked, ...own } : own;
  };
  const rows = () => {
    const snapshot = session.getSnapshot();
    const loaded = snapshot.windows?.rows ?? [];
    return applyCellPatches(
      mode === "rows" && snapshot.placed.length > 0
        ? [...loaded, ...snapshot.placed.map((entry) => entry.row)]
        : loaded,
      pending(),
    );
  };
  const groups = () => {
    const snapshot = session.getSnapshot();
    return (snapshot.windows?.groups ?? []).map((bucket) => {
      const id = canonicalJson(bucket.key);
      const extra = snapshot.placed.filter((entry) => entry.group === id).map((entry) => entry.row);
      const patched = applyCellPatches(
        extra.length > 0 ? [...bucket.rows, ...extra] : bucket.rows,
        pending(),
      );
      return patched === bucket.rows && extra.length === 0
        ? bucket
        : { ...bucket, rows: patched, count: bucket.count + extra.length };
    });
  };

  /** Resolves once `predicate` holds, running scheduled refreshes as they are asked for. */
  const until = (predicate: () => boolean) =>
    new Promise<void>((resolve) => {
      const stopWatching: Array<() => void> = [];
      const step = () => {
        if (predicate()) {
          for (const stop of stopWatching) stop();
          resolve();
        } else if (clock.pending() > 0) clock.tick();
      };
      stopWatching.push(session.subscribe(step), writer.subscribe(step), clock.watch(step));
      step();
    });

  return {
    session,
    /** The view changed (an edit, applied optimistically): the session follows with a new key. */
    retarget: (next: C.SpaceDatabaseView) => {
      input = viewInputOf(model, next, viewColumns(next, dataSource), viewOptions);
      dependencies = dependenciesOf(next);
      session.setInput(input, { fillRows: options.fillRows ?? 0 });
    },
    input: () => input,
    rows,
    groups,
    total: () => session.getSnapshot().windows?.total,
    aggregates: () => session.getSnapshot().aggregates,
    snapshot: () => session.getSnapshot(),
    until,
    /** The first answer. */
    ready: async () => {
      await until(() => ["ready", "error"].includes(session.getSnapshot().status));
      const { status, error } = session.getSnapshot();
      if (status === "error")
        throw error instanceof Error ? error : new Error(JSON.stringify(error));
    },
    dispose: () => {
      disconnect();
      session.dispose();
    },
  };
}

export type ViewQueryHandle = ReturnType<typeof openViewQuery>;

/**
 * A database block as the surface holds it: model, optimistic view edits, and the real actions.
 * `reload` is what a counter bump does to the model atom.
 */
export async function openSurface(
  registry: AtomRegistry.AtomRegistry,
  databaseId: C.SpaceDatabaseId,
  limits: C.SpaceDatabaseLimits,
  viewIds?: ReadonlyArray<C.SpaceViewId>,
) {
  const writer = databaseStores(registry).writer(environmentId);
  let edits: ViewEdits = [];
  let editId = 0;
  let model!: DatabaseModel;
  let active: C.SpaceViewId | undefined;
  let blockViews: ReadonlyArray<C.SpaceViewId> = [];
  const editWaiters = new Set<() => void>();
  const notifyEdits = () => {
    for (const waiter of editWaiters) waiter();
  };
  const reload = async () => {
    const answer = unwrap(
      await executeAtomQuery(registry, databasePorts.databaseAtom(environmentId, databaseId), {
        refresh: true,
        reportFailure: false,
      }),
    );
    model = {
      environmentId,
      database: answer.database,
      dataSources: answer.dataSources,
      views: answer.views,
      limits,
      permissions: {
        cells: registry.get(databasePorts.permission.cells(environmentId)),
        rows: registry.get(databasePorts.permission.rows(environmentId)),
        schema: registry.get(databasePorts.permission.schema(environmentId)),
        views: registry.get(databasePorts.permission.views(environmentId)),
        title: registry.get(databasePorts.permission.rename(environmentId)),
        block: true,
      },
    };
  };
  await reload();
  blockViews = viewIds ?? [model.views[0]!.id];
  active = blockViews[0];
  const tabs = () =>
    resolveBlockViews(blockViews, model.views).map((view) =>
      effectiveView(view, edits, model.database.revision),
    );
  const view = () => tabs().find((entry) => entry.id === active) ?? tabs()[0]!;
  const dataSource = () => model.dataSources.find((source) => source.id === view().dataSourceId)!;
  const actions: DatabaseActions = createDatabaseActions({
    registry,
    state: () => ({
      model,
      dataSource: dataSource(),
      view: view(),
      viewIds: blockViews,
      block: {
        setViews: (next) => {
          blockViews = next;
          return true;
        },
        remove: () => true,
      },
      host: null,
      peek: null,
    }),
    queueViewEdit: (viewId: C.SpaceViewId, patch: ViewPatch) => {
      const id = ++editId;
      edits = queueViewEdit(edits, { id, viewId, patch, ack: undefined }, model.database.revision);
      return id;
    },
    ackViewEdit: (id, revision) => {
      edits = ackViewEdit(edits, id, revision);
      notifyEdits();
    },
    dropViewEdit: (id) => {
      edits = dropViewEdit(edits, id);
      notifyEdits();
    },
    activate: (viewId) => {
      active = viewId;
    },
  });
  return {
    registry,
    writer,
    actions,
    model: () => model,
    view,
    tabs,
    dataSource,
    reload,
    activate: (viewId: C.SpaceViewId) => {
      active = viewId;
    },
    /** Waits for the queued view edits to reach the server, then re-reads the model. */
    saved: async () => {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (edits.some((edit) => edit.ack === undefined)) return;
          editWaiters.delete(check);
          resolve();
        };
        editWaiters.add(check);
        check();
      });
      await reload();
      edits = [];
    },
    openQuery: (options?: Partial<ViewQueryOptions> & { readonly fillRows?: number }) =>
      openViewQuery(registry, writer, model, view(), options),
  };
}

export type Surface = Awaited<ReturnType<typeof openSurface>>;
