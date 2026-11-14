import {
  type ViewColumn,
  canonicalJson,
  cellForGroupKey,
  groupLabel,
  newRowCells,
  subItemCells,
} from "@t2code/client-runtime/spaces";
import { useLayoutEffect, useState } from "react";
import {
  SpaceKnownGroupKey,
  type SpaceDatabaseRow,
  type SpaceGroupKey,
  type SpacePageId,
} from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";

import type { RowOpenMode } from "../data/actions";
import { Latest } from "../data/latest";
import { useNestedSubItems, useSubItems } from "../data/useSubItems";
import { useViewQuery } from "../data/useViewQuery";
import { useDatabase, useDatabaseActions } from "../shell/context";
import { buildGridItems, visibleBuckets } from "../table/gridItems";
import { moveTarget } from "./listLayout";

const GROUP_ROWS = 25;
export const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const isKnownGroupKey = Schema.is(SpaceKnownGroupKey);

const localDay = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/** What a row's menu and the add buttons call; one stable object, so memoized rows keep their props. */
export interface RowListHandlers {
  open(pageId: SpacePageId, mode?: RowOpenMode): void;
  trash(pageId: SpacePageId): void;
  move(pageId: SpacePageId, direction: "up" | "down"): void;
  add(group: SpaceGroupKey | null): void;
  toggleGroup(id: string): void;
  loadBucket(key: SpaceGroupKey): void;
  toggleRow(pageId: SpacePageId): void;
  addSubItem(parentId: SpacePageId): void;
  loadChildren(parentId: SpacePageId): void;
  /** Whether the row menu offers `Add sub-item`. */
  readonly canSubItems: boolean;
}

/**
 * The data a list or gallery body shares: the windowed query (rows, or groups when the view
 * groups), the table's group collapse state, and the row actions.
 */
export function useRowList(
  search: string,
  queryColumns: ReadonlyArray<ViewColumn>,
  options: { readonly cover?: boolean; readonly nested?: boolean } = {},
) {
  const { model, view, columns, dataSource, optionHint } = useDatabase();
  const actions = useDatabaseActions();
  const { permissions, limits } = model;
  const groupDef = view.group;
  const groupColumn =
    groupDef === undefined
      ? undefined
      : columns.find((column) => column.property.id === groupDef.property);
  const groupKnown = groupColumn?.known ?? null;
  const nested = useNestedSubItems(view, search) && options.nested === true;
  const query = useViewQuery(view, queryColumns, {
    mode: groupColumn === undefined ? "rows" : "groups",
    rowsPerGroup: Math.min(GROUP_ROWS, limits.maxGroupPreviewRows),
    search,
    ...(options.cover === true ? { cover: true } : {}),
    ...(nested ? { scope: { parentRowId: null } } : {}),
  });
  const subs = useSubItems(view, queryColumns, { enabled: nested });
  // Keep the query's own object while no sub-item brings pages: memoized rows compare it by identity.
  const relatedPages =
    Object.keys(subs.relatedPages).length === 0
      ? query.relatedPages
      : { ...query.relatedPages, ...subs.relatedPages };

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set((view.group?.collapsed ?? []).map((key) => canonicalJson(key))),
  );
  const [adding, setAdding] = useState<string | null>(null);
  const [busy] = useState(() => ({ adding: false }));
  const keyWritable = (key: SpaceGroupKey) =>
    groupKnown !== null && isKnownGroupKey(key) && cellForGroupKey(key, groupKnown) !== undefined;
  const buckets = query.groups === null ? null : visibleBuckets(query.groups, groupDef);
  const items = buildGridItems({
    rows: query.rows as ReadonlyArray<SpaceDatabaseRow>,
    groups: buckets,
    collapsed,
    hasMore: query.hasMore,
    loadingMore: query.loadingMore,
    canAdd: buckets === null ? permissions.rows : (key) => permissions.rows && keyWritable(key),
    bucketLoading: query.bucketLoading,
    ...(subs.tree === undefined ? {} : { tree: subs.tree }),
  }).items;

  const [latest] = useState(() => new Latest<RowListHandlers | null>(null));
  const [handlers] = useState(() => stableHandlers(latest));
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Point the stable handlers at the latest items and query so memoized rows keep their props.
  useLayoutEffect(() => {
    latest.set({
      open: (pageId, mode) => actions.openRow(pageId, mode),
      trash: (pageId) =>
        void actions.trashRow(pageId).then((trashed) => {
          if (trashed) query.forgetRow(pageId);
        }),
      move: (pageId, direction) => {
        const target = moveTarget(items, pageId, direction);
        if (target !== null)
          void actions.moveRows([target.moving as SpacePageId], target.before as SpacePageId);
      },
      toggleGroup: (id) =>
        setCollapsed((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);
          return next;
        }),
      loadBucket: (key) => query.loadBucket(key),
      toggleRow: (pageId) => subs.toggle(pageId),
      loadChildren: (parentId) => subs.loadMore(parentId),
      canSubItems: nested && dataSource.subItems !== undefined,
      addSubItem: (parentId) => {
        const parentProperty = dataSource.subItems?.parentPropertyId;
        if (!nested || parentProperty === undefined || !permissions.rows) return;
        subs.expand(parentId);
        void actions.createRow({ cells: subItemCells(parentProperty, parentId) });
      },
      add: (group) => {
        if (busy.adding || !permissions.rows) return;
        const key = group !== null && isKnownGroupKey(group) ? group : undefined;
        if (group !== null && key === undefined) return;
        busy.adding = true;
        setAdding(group === null ? "" : canonicalJson(group));
        const release = query.hold();
        void actions
          .createRow({
            cells: newRowCells({
              filter: view.filter,
              properties: Object.fromEntries(
                columns.map((column) => [column.property.id, column.property]),
              ),
              ...(groupDef === undefined || key === undefined
                ? {}
                : { group: { property: groupDef.property, key } }),
              today: localDay(),
            }),
          })
          .then((row) => {
            if (row === null) return;
            query.placeRow(row, group);
            actions.openRow(row.page.id);
          })
          .finally(() => {
            release();
            busy.adding = false;
            setAdding(null);
          });
      },
    });
  });

  const hasData = query.rows.length > 0 || query.groups !== null || query.status === "ready";
  const noRows =
    query.status === "ready" &&
    !query.hasMore &&
    !items.some((item) => item.kind === "row") &&
    (buckets === null || buckets.every((bucket) => bucket.count === 0));

  return {
    query,
    relatedPages,
    items,
    handlers,
    adding,
    hasData,
    noRows,
    manualOrder: view.sorts.length === 0,
    labelOf: (bucket: Parameters<typeof groupLabel>[0]) =>
      groupLabel(bucket, groupKnown, groupColumn?.property.name ?? "value", optionHint),
  };
}

function stableHandlers(latest: Latest<RowListHandlers | null>): RowListHandlers {
  return {
    open: (pageId, mode) => latest.get()?.open(pageId, mode),
    trash: (pageId) => latest.get()?.trash(pageId),
    move: (pageId, direction) => latest.get()?.move(pageId, direction),
    add: (group) => latest.get()?.add(group),
    toggleGroup: (id) => latest.get()?.toggleGroup(id),
    loadBucket: (key) => latest.get()?.loadBucket(key),
    toggleRow: (pageId) => latest.get()?.toggleRow(pageId),
    addSubItem: (parentId) => latest.get()?.addSubItem(parentId),
    loadChildren: (parentId) => latest.get()?.loadChildren(parentId),
    get canSubItems() {
      return latest.get()?.canSubItems ?? false;
    },
  };
}
