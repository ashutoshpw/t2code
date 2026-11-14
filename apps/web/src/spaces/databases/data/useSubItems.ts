import { RegistryContext } from "@effect/atom-react";
import {
  SubItemTree,
  applyCellPatches,
  queryKey,
  viewDependencies,
  type ViewColumn,
} from "@t2code/client-runtime/spaces";
import type { SpaceDatabaseView, SpaceRelatedPage } from "@t2code/contracts/spaces";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";

import type { SubItemTreeInput } from "../table/gridItems";
import { useDatabase } from "../shell/context";
import { Latest } from "./latest";
import { databasePorts } from "./ports";
import { databaseStores } from "./stores";
import { viewInputOf } from "./useViewQuery";

/** Expanded parents that keep a query session; one more collapses the oldest. */
const MAX_EXPANDED_PARENTS = 50;

const NO_PAGES: Readonly<Record<string, SpaceRelatedPage>> = {};

const intersects = (dependencies: ReadonlySet<string>, ids: ReadonlySet<string>) => {
  for (const id of ids) if (dependencies.has(id)) return true;
  return false;
};

/**
 * Nested rows apply to a table or list that is not grouped and not searching, in a data source
 * with sub-items turned on, unless the view's layout flattens them.
 */
export function useNestedSubItems(view: SpaceDatabaseView, search: string): boolean {
  const { dataSource, known } = useDatabase();
  const mode = known === null ? undefined : (known.layout as { subItems?: string }).subItems;
  return (
    dataSource.subItems !== undefined &&
    view.group === undefined &&
    search === "" &&
    (mode === undefined || mode === "nested")
  );
}

/**
 * One session per expanded parent under the top-level query. The top level asks with
 * `scope.parentRowId: null` (see `useViewQuery`), which makes every row carry `childCount`.
 */
export function useSubItems(
  view: SpaceDatabaseView,
  columns: ReadonlyArray<ViewColumn>,
  options: { readonly enabled: boolean; readonly rowsPerGroup?: number },
) {
  const { model } = useDatabase();
  const registry = useContext(RegistryContext);
  const { environmentId } = model;
  const dataSourceId = view.dataSourceId;
  const writer = databaseStores(registry).writer(environmentId);
  const [source] = useState(() => new Latest({ dataSourceId, writer }));
  const [tree] = useState(
    () =>
      new SubItemTree(
        {
          query: (input) => databasePorts.query(registry, input),
          schedule: (run, delayMs) => {
            const timer = setTimeout(run, delayMs);
            return () => clearTimeout(timer);
          },
          busy: () => source.get().writer.busy(source.get().dataSourceId),
          live: () => databasePorts.live(registry, environmentId),
        },
        { maxExpanded: MAX_EXPANDED_PARENTS },
      ),
  );
  const input = options.enabled
    ? viewInputOf(model, view, columns, {
        mode: "rows",
        search: "",
        scope: { parentRowId: null },
        ...(options.rowsPerGroup === undefined ? {} : { rowsPerGroup: options.rowsPerGroup }),
      })
    : null;
  const key = input === null ? null : queryKey(input);
  const dependencies = viewDependencies(
    view,
    undefined,
    model.dataSources.find((entry) => entry.id === view.dataSourceId),
    columns.filter((column) => column.visible).map((column) => column.property.id),
  );
  const [watch] = useState(() => new Latest(dependencies));

  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Point the external sub-item sessions at the current top-level query; a key change re-queries every expanded parent.
  useEffect(() => {
    // `key` is the identity of `input` and `dependencies`; both are rebuilt on every render.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
    watch.set(dependencies);
    source.set({ dataSourceId, writer });
    tree.setBase(input);
  }, [tree, key, watch, source, dataSourceId, writer]);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Subscribe the external sessions to counter bumps and acknowledged own writes, and dispose them on unmount.
  useEffect(() => {
    const stop = [
      registry.subscribe(databasePorts.changed.dataSource(environmentId, dataSourceId), () =>
        tree.invalidate(),
      ),
      writer.onAck((ack) => {
        if (ack.dataSourceId !== dataSourceId) return;
        tree.noteAck({
          dataRevision: ack.dataRevision,
          affects: intersects(watch.get(), ack.propertyIds),
          structural: ack.structural,
          edits: ack.edits,
        });
      }),
    ];
    return () => {
      for (const unsubscribe of stop) unsubscribe();
    };
  }, [tree, writer, registry, environmentId, dataSourceId, watch]);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Close the external sessions with the view body; reset keeps the tree usable when StrictMode re-runs the cleanup.
  useEffect(() => () => tree.reset(), [tree]);

  const snapshot = useSyncExternalStore(tree.subscribe, tree.getSnapshot);
  const written = useSyncExternalStore(writer.subscribe, writer.getSnapshot);
  const pending = Object.fromEntries(
    Object.entries(written.pending).filter(([, edit]) => edit.dataSourceId === dataSourceId),
  );

  const relatedPages: Record<string, SpaceRelatedPage> = {};
  const children = new Map<
    string,
    {
      rows: ReturnType<typeof applyCellPatches>;
      status: "loading" | "ready" | "error";
      hasMore: boolean;
      loadingMore: boolean;
    }
  >();
  for (const [id, entry] of snapshot.children) {
    children.set(id, { ...entry, rows: applyCellPatches(entry.rows, pending) });
    Object.assign(relatedPages, entry.relatedPages);
  }
  const treeInput: SubItemTreeInput = {
    children,
    canAddChild: model.permissions.rows,
  };
  return {
    tree: options.enabled ? treeInput : undefined,
    relatedPages: Object.keys(relatedPages).length === 0 ? NO_PAGES : relatedPages,
    expand: (id: string) => tree.expand(id as never),
    collapse: (id: string) => tree.collapse(id as never),
    toggle: (id: string) => {
      if (tree.isExpanded(id)) tree.collapse(id as never);
      else tree.expand(id as never);
    },
    isExpanded: (id: string) => tree.isExpanded(id),
    loadMore: (id: string) => tree.loadMore(id as never),
    noteRelatedPages: (pages: Readonly<Record<string, SpaceRelatedPage>>) =>
      tree.noteRelatedPages(pages),
  };
}
