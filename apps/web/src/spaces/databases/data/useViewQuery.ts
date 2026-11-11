import { RegistryContext } from "@effect/atom-react";
import {
  DatabaseQuerySession,
  deriveViewRows,
  canonicalJson,
  queryKey,
  viewDependencies,
  viewQueryInput,
  type PendingCellEdits,
  type RowPlacement,
  type ViewColumn,
} from "@t2code/client-runtime/spaces";
import type {
  SpaceAggregateResult,
  SpaceDatabaseRow,
  SpaceDatabaseView,
  SpaceGroupBucket,
  SpaceFilter,
  SpaceGroupKey,
  SpacePageId,
  SpacePropertyId,
  SpaceRelatedPage,
} from "@t2code/contracts/spaces";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";

import { useDatabase } from "../shell/context";
import type { DatabaseModel } from "./useDatabaseModel";
import { databaseErrorMessage } from "@t2code/client-runtime/spaces";
import { Latest } from "./latest";
import { databasePorts } from "./ports";
import { databaseStores } from "./stores";

export interface ViewQueryOptions {
  readonly mode: "rows" | "groups";
  readonly rowsPerGroup?: number;
  readonly search: string;
  /** ANDed with the view's filter: a calendar's visible range, the rows without a date. */
  readonly extraFilter?: SpaceFilter;
  /** Cells to return even when the view hides them (the date a calendar or timeline places rows by). */
  readonly extraPropertyIds?: ReadonlyArray<SpacePropertyId>;
  /** Sub-items: the children of one row, or null for the top level. */
  readonly scope?: { readonly parentRowId: SpacePageId | null };
  /** Ask for each row's first body image (the gallery's `page_content` preview). */
  readonly cover?: boolean;
  /** Keep loading windows until the query is whole or this many rows are loaded. */
  readonly fillRows?: number;
}

export interface ViewQuery {
  readonly status: "loading" | "ready" | "error";
  readonly error: string | null;
  retry(): void;
  /** A continuation or refresh failed while rows are shown. */
  readonly loadError: string | null;
  retryLoad(): void;
  /** Pages a write just referenced, shown before the next answer carries them. */
  noteRelatedPages(pages: Readonly<Record<string, SpaceRelatedPage>>): void;
  readonly stale: boolean;
  /** Rows mode: loaded rows and placed rows, with pending edits applied. */
  readonly rows: ReadonlyArray<SpaceDatabaseRow>;
  /** Groups mode: bucket rows with pending edits applied, placed rows appended. */
  readonly groups: ReadonlyArray<SpaceGroupBucket> | null;
  readonly groupsTruncated: boolean;
  readonly total: number | undefined;
  readonly aggregates: ReadonlyArray<SpaceAggregateResult>;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  loadMore(): void;
  loadBucket(key: SpaceGroupKey, subKey?: SpaceGroupKey): void;
  bucketLoading(key: SpaceGroupKey, subKey?: SpaceGroupKey): boolean;
  hold(): () => void;
  placeRow(row: SpaceDatabaseRow, group: SpaceGroupKey | null): void;
  /** Card drops kept until the next refresh answers; clear one with `undefined`. */
  readonly placements: Readonly<Record<string, RowPlacement>>;
  setPlacement(pageId: string, placement: RowPlacement | undefined): void;
  /** Of this data source: the board regroups with it. */
  readonly pending: PendingCellEdits;
}

const BACKGROUND_REFRESH_MS = 30_000;
const intersects = (dependencies: ReadonlySet<string>, ids: ReadonlySet<string>) => {
  for (const id of ids) if (dependencies.has(id)) return true;
  return false;
};
const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The explicit query a view body runs; also what sub-item sessions derive their scope from. */
export function viewInputOf(
  model: DatabaseModel,
  view: SpaceDatabaseView,
  columns: ReadonlyArray<ViewColumn>,
  options: ViewQueryOptions,
) {
  return viewQueryInput(view, {
    environmentId: model.environmentId,
    mode: options.mode,
    timeZone: viewerZone(),
    limit: Math.min(100, model.limits.maxQueryRows),
    ...(options.rowsPerGroup === undefined ? {} : { rowsPerGroup: options.rowsPerGroup }),
    search: options.search,
    visiblePropertyIds: columns
      .filter((column) => column.visible)
      .map((column) => column.property.id),
    includeAggregates: true,
    ...(options.extraFilter === undefined ? {} : { extraFilter: options.extraFilter }),
    ...(options.extraPropertyIds === undefined
      ? {}
      : { extraPropertyIds: options.extraPropertyIds }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.cover === true ? { cover: true } : {}),
  });
}

/**
 * One query session per call site; the view body re-derives rows in render from the session and
 * the writer, so an edit gives one row a new identity and nothing else re-renders.
 */
export function useViewQuery(
  view: SpaceDatabaseView,
  columns: ReadonlyArray<ViewColumn>,
  options: ViewQueryOptions,
): ViewQuery {
  const { model } = useDatabase();
  const registry = useContext(RegistryContext);
  const { environmentId } = model;
  const dataSourceId = view.dataSourceId;
  const writer = databaseStores(registry).writer(environmentId);
  // Read at call time: a view whose data source changes keeps its session.
  const [source] = useState(() => new Latest({ dataSourceId, writer }));
  const [session] = useState(
    () =>
      new DatabaseQuerySession({
        query: (input) => databasePorts.query(registry, input),
        schedule: (run, delayMs) => {
          const timer = setTimeout(run, delayMs);
          return () => clearTimeout(timer);
        },
        busy: () => source.get().writer.busy(source.get().dataSourceId),
      }),
  );
  const input = viewInputOf(model, view, columns, options);
  const key = queryKey(input);
  const dependencies = viewDependencies(
    view,
    options.extraFilter,
    model.dataSources.find((entry) => entry.id === dataSourceId),
    columns.filter((column) => column.visible).map((column) => column.property.id),
  );
  // What the ack listener compares against; refreshed together with the query input.
  const [watch] = useState(() => new Latest(dependencies));
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Drive the external query session from the derived input; a key change keeps the old windows until the new ones arrive.
  useEffect(() => {
    // `key` is the identity of `input` and `dependencies`; both objects are rebuilt on every render.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
    watch.set(dependencies);
    source.set({ dataSourceId, writer });
    session.setInput(input, { fillRows: options.fillRows ?? 0 });
  }, [session, key, watch, source, dataSourceId, writer, options.fillRows]);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Subscribe the external session to counter bumps, acknowledged own writes and window focus.
  useEffect(() => {
    let leftAt: number | null = null;
    const left = () => {
      if (leftAt === null) leftAt = Date.now();
    };
    const back = () => {
      if (leftAt !== null && Date.now() - leftAt >= BACKGROUND_REFRESH_MS) session.refresh();
      leftAt = null;
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? left() : back());
    const stop = [
      registry.subscribe(databasePorts.changed.dataSource(environmentId, dataSourceId), () =>
        session.invalidate(),
      ),
      writer.onAck((ack) => {
        if (ack.dataSourceId !== dataSourceId) return;
        session.noteAck({
          dataRevision: ack.dataRevision,
          affects: intersects(watch.get(), ack.propertyIds),
          structural: ack.structural,
          edits: ack.edits,
        });
      }),
    ];
    window.addEventListener("blur", left);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      for (const unsubscribe of stop) unsubscribe();
      window.removeEventListener("blur", left);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", onVisibility);
      // Clears timers and drops late answers; the next mount sets its input again.
      session.setInput(null);
    };
  }, [session, writer, registry, environmentId, dataSourceId, watch]);

  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const written = useSyncExternalStore(writer.subscribe, writer.getSnapshot);
  const windows = snapshot.windows;
  const { rows, groups, pending } = deriveViewRows({
    mode: options.mode,
    dataSourceId,
    snapshot,
    writerPending: written.pending,
  });

  return {
    status: snapshot.status === "idle" ? "loading" : snapshot.status,
    error: snapshot.status === "error" ? databaseErrorMessage(snapshot.error) : null,
    retry: () => session.refresh(),
    loadError: snapshot.loadError === undefined ? null : databaseErrorMessage(snapshot.loadError),
    retryLoad: () => session.retryLoad(),
    noteRelatedPages: (pages) => session.noteRelatedPages(pages),
    stale: snapshot.stale,
    rows,
    groups,
    groupsTruncated: windows?.groupsTruncated ?? false,
    total: windows?.total,
    aggregates: snapshot.aggregates,
    relatedPages: snapshot.relatedPages,
    hasMore: windows?.nextCursor != null,
    loadingMore: snapshot.loadingMore,
    loadMore: () => session.loadMore(),
    loadBucket: (bucketKey, subKey) => session.loadBucket(bucketKey, subKey),
    bucketLoading: (bucketKey, subKey) =>
      snapshot.loadingBuckets.has(
        subKey === undefined
          ? canonicalJson(bucketKey)
          : `${canonicalJson(bucketKey)}/${canonicalJson(subKey)}`,
      ),
    hold: () => session.hold(),
    placeRow: (row, group) => session.placeRow(row, group),
    placements: snapshot.placements,
    setPlacement: (pageId, placement) => session.setPlacement(pageId, placement),
    pending,
  };
}
