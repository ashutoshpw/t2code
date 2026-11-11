import {
  cellForGroupKey,
  canonicalJson,
  newRowCells,
  type ViewColumn,
} from "@t2code/client-runtime/spaces";
import { useLayoutEffect, useState } from "react";
import {
  SpaceKnownGroupKey,
  type SpaceDatabaseRow,
  type SpaceGroupBucket,
  type SpaceGroupKey,
} from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { editorKind } from "../cells/CellEditor";
import { Latest } from "../data/latest";
import { useViewQuery } from "../data/useViewQuery";
import { useDatabase, useDatabaseActions } from "../shell/context";
import type { DatabaseViewProps } from "../shell/viewTypes";
import { GridEditStore } from "./gridEditStore";
import { createGridHandlers, type GridModel } from "./gridHandlers";
import { buildGridItems, visibleBuckets } from "./gridItems";
import { DEFAULT_COLUMN_WIDTH, TITLE_COLUMN_WIDTH, clampWidth } from "./gridWindow";
import { GridViewport } from "./GridViewport";
import { groupLabel } from "./groupLabel";
import type { TableColumn } from "./tableTypes";

const GROUP_ROWS = 25;
const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const isKnownGroupKey = Schema.is(SpaceKnownGroupKey);

const localDay = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

const toTableColumn = (column: ViewColumn): TableColumn => ({
  id: column.property.id,
  name: column.property.name,
  known: column.known,
  type: column.property.type,
  width: clampWidth(
    column.width ?? (column.property.id === "title" ? TITLE_COLUMN_WIDTH : DEFAULT_COLUMN_WIDTH),
  ),
  writable: column.known !== null && editorKind(column.property.type) !== "none",
});

function TableLoading() {
  return (
    <div role="status" aria-label="Loading rows" className="space-y-1 rounded-lg border p-1">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-[30px] w-full" />
      ))}
    </div>
  );
}

export default function TableView({ search }: DatabaseViewProps) {
  const { model, view, columns, layout: surfaceLayout, optionHint } = useDatabase();
  const actions = useDatabaseActions();
  const { permissions, limits, environmentId } = model;
  const groupDef = view.group;
  const groupColumn =
    groupDef === undefined
      ? undefined
      : columns.find((column) => column.property.id === groupDef.property);
  const groupKnown = groupColumn?.known ?? null;
  const mode = groupColumn === undefined ? "rows" : "groups";
  const query = useViewQuery(view, columns, {
    mode,
    rowsPerGroup: Math.min(GROUP_ROWS, limits.maxGroupPreviewRows),
    search,
  });

  const visible = columns.filter((column) => column.visible);
  const title = visible.find((column) => column.property.id === "title");
  const tableColumns = [
    ...(title === undefined ? [] : [title]),
    ...visible.filter((column) => column !== title),
  ].map(toTableColumn);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set((view.group?.collapsed ?? []).map((key) => canonicalJson(key))),
  );
  const keyWritable = (key: SpaceGroupKey) =>
    groupKnown !== null && isKnownGroupKey(key) && cellForGroupKey(key, groupKnown) !== undefined;
  const buckets: ReadonlyArray<SpaceGroupBucket> | null =
    query.groups === null ? null : visibleBuckets(query.groups, view.group);
  const layout = buildGridItems({
    rows: query.rows as ReadonlyArray<SpaceDatabaseRow>,
    groups: buckets,
    collapsed,
    hasMore: query.hasMore,
    loadingMore: query.loadingMore,
    canAdd: buckets === null ? permissions.rows : (key) => permissions.rows && keyWritable(key),
    bucketLoading: query.bucketLoading,
  });

  const [store] = useState(() => new GridEditStore());
  const [latest] = useState(() => new Latest<GridModel | null>(null));
  const [grid] = useState(() => createGridHandlers(store, latest));
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Point the stable grid handlers at the latest rows, columns and query so cells keep their identity.
  useLayoutEffect(() => {
    latest.set({
      layout,
      columns: tableColumns,
      canEdit: permissions.cells,
      canAdd: permissions.rows,
      actions,
      hold: query.hold,
      placeRow: query.placeRow,
      loadBucket: query.loadBucket,
      toggleGroup: (id) =>
        setCollapsed((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);
          return next;
        }),
      newRowCells: (group) => {
        const key = group !== null && isKnownGroupKey(group) ? group : undefined;
        return newRowCells({
          filter: view.filter,
          properties: Object.fromEntries(
            columns.map((column) => [column.property.id, column.property]),
          ),
          ...(groupDef === undefined || key === undefined
            ? {}
            : { group: { property: groupDef.property, key } }),
          today: localDay(),
        });
      },
      text: { relatedPages: query.relatedPages, optionHint, timeZone: VIEWER_ZONE },
      notePages: query.noteRelatedPages,
    });
  });

  const hasData = query.rows.length > 0 || query.groups !== null || query.status === "ready";
  if (query.status === "error" && !hasData)
    return (
      <div role="alert" className="flex items-center gap-2 rounded-lg border px-3 py-4 text-sm">
        <span className="min-w-0 flex-1">{query.error ?? "Couldn't load the rows."}</span>
        <Button size="xs" variant="outline" onClick={query.retry}>
          Retry
        </Button>
      </div>
    );
  if (!hasData) return <TableLoading />;

  const aggregateFns = new Map(
    columns.flatMap((column) =>
      column.aggregate === undefined ? [] : [[column.property.id as string, column.aggregate]],
    ),
  );
  const noRows =
    query.status === "ready" &&
    !query.hasMore &&
    layout.rowIds.length === 0 &&
    (buckets === null || buckets.every((bucket) => bucket.count === 0));
  const rowsLoaded = layout.rowIds.length;
  const ariaRowCount =
    layout.items.length +
    2 +
    (buckets === null && query.total !== undefined ? Math.max(0, query.total - rowsLoaded) : 0);

  return (
    <GridViewport
      layout={layout}
      columns={tableColumns}
      relatedPages={query.relatedPages}
      optionHint={optionHint}
      timeZone={VIEWER_ZONE}
      environmentId={environmentId}
      spaceId={model.database.spaceId}
      canEdit={permissions.cells}
      canTrash={permissions.rows}
      canSchema={permissions.schema}
      canViews={permissions.views}
      store={store}
      grid={grid}
      aggregates={query.aggregates}
      aggregateOf={(id) => aggregateFns.get(id)}
      total={query.total}
      ariaRowCount={ariaRowCount}
      busy={query.stale}
      pageLayout={surfaceLayout}
      labelOf={(bucket) =>
        groupLabel(bucket, groupKnown, groupColumn?.property.name ?? "value", optionHint)
      }
      onNearEnd={() => {
        if (query.hasMore && !query.loadingMore && query.loadError === null) query.loadMore();
      }}
      below={
        query.loadError !== null ? (
          <div
            role="alert"
            className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
          >
            <span className="min-w-0 flex-1">Couldn't load more.</span>
            <Button size="xs" variant="outline" onClick={query.retryLoad}>
              Retry
            </Button>
          </div>
        ) : noRows ? (
          <p role="status" className="px-3 py-4 text-sm text-muted-foreground">
            {view.filter !== undefined || search !== ""
              ? "Nothing matches this view"
              : "No rows yet"}
          </p>
        ) : null
      }
    />
  );
}
