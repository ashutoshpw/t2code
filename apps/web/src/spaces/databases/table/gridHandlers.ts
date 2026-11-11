import { type CellTextContext, canonicalJson, subItemCells } from "@t2code/client-runtime/spaces";
import type {
  SpaceCellValue,
  SpaceDatabaseRow,
  SpaceGroupKey,
  SpacePageId,
  SpacePropertyId,
  SpaceRelatedPage,
} from "@t2code/contracts/spaces";

import { editorKind } from "../cells/CellEditor";
import { parseCell } from "@t2code/client-runtime/spaces";
import type { DatabaseActions } from "../data/actions";
import type { Latest } from "../data/latest";
import { GridEditStore } from "./gridEditStore";
import type { GridLayout } from "./gridItems";
import { nextCell } from "./gridNavigation";
import { FOOTER_HEIGHT, scrollToCell } from "./gridWindow";
import { cellCopyText } from "./tableCopy";
import type { GridHandlers, TableColumn } from "./tableTypes";

/** What the handlers read at call time. */
export interface GridModel {
  readonly layout: GridLayout;
  /** Visible columns, title first. */
  readonly columns: ReadonlyArray<TableColumn>;
  readonly canEdit: boolean;
  readonly canAdd: boolean;
  readonly actions: Pick<DatabaseActions, "editCell" | "createRow" | "trashRow" | "openRow">;
  hold(): () => void;
  placeRow(row: SpaceDatabaseRow, group: SpaceGroupKey | null): void;
  loadBucket(key: SpaceGroupKey): void;
  toggleGroup(id: string): void;
  newRowCells(group: SpaceGroupKey | null): Record<string, SpaceCellValue>;
  readonly text: CellTextContext;
  notePages(pages: Readonly<Record<string, SpaceRelatedPage>>): void;
  /** The sub-items parent property when nested rows are on. */
  readonly subItems: { readonly parentPropertyId: string } | null;
  setExpanded(pageId: string, expand: boolean): void;
  loadChildren(parentId: string): void;
}

const sameValue = (a: SpaceCellValue | null | undefined, b: SpaceCellValue | null) =>
  canonicalJson(a ?? null) === canonicalJson(b);

const escapeSelector = (value: string) => CSS.escape(value);

export function createGridHandlers(
  store: GridEditStore,
  latest: Latest<GridModel | null>,
): GridHandlers {
  let release: (() => void) | null = null;
  let adding = false;

  const model = () => {
    const value = latest.get();
    if (value === null) throw new Error("The grid handlers ran before the table mounted");
    return value;
  };
  const rowOf = (pageId: string) => {
    const { layout } = model();
    const item = layout.items[layout.itemIndexByRow.get(pageId) ?? -1];
    return item?.kind === "row" ? item.row : undefined;
  };
  const valueOf = (pageId: string, propertyId: string): SpaceCellValue | undefined =>
    rowOf(pageId)?.cells[propertyId];
  const columnOf = (propertyId: string) =>
    model().columns.find((column) => column.id === propertyId);
  const writable = (propertyId: string) => {
    const column = columnOf(propertyId);
    return model().canEdit && column !== undefined && column.writable && column.known !== null;
  };
  const endEdit = () => {
    store.stop();
    release?.();
    release = null;
  };

  const focus: GridHandlers["focus"] = (pageId, propertyId) => {
    const m = model();
    const root = store.root;
    const itemIndex = m.layout.itemIndexByRow.get(pageId);
    if (root === null || itemIndex === undefined) return;
    const others = m.columns.slice(1);
    const columnAt = others.findIndex((column) => column.id === propertyId);
    const columnLeft =
      columnAt < 0
        ? null
        : others.slice(0, columnAt).reduce((sum, column) => sum + column.width, 0);
    const { top, left } = scrollToCell({
      itemTop: m.layout.offsets[itemIndex] ?? 0,
      itemHeight: m.layout.rowHeight,
      columnLeft,
      columnWidth: columnAt < 0 ? 0 : others[columnAt]!.width,
      scrollTop: root.scrollTop,
      scrollLeft: root.scrollLeft,
      viewportHeight: root.clientHeight,
      viewportWidth: root.clientWidth,
      frozenWidth: m.columns[0]?.width ?? 0,
      footerHeight: FOOTER_HEIGHT,
    });
    if (top !== root.scrollTop) root.scrollTop = top;
    if (left !== root.scrollLeft) root.scrollLeft = left;
    const element = root.querySelector<HTMLElement>(
      `[data-row="${escapeSelector(pageId)}"][data-col="${escapeSelector(propertyId)}"]`,
    );
    if (element === null) store.want(pageId, propertyId);
    else element.focus({ preventScroll: true });
  };

  const navigate: GridHandlers["navigate"] = (from, key) => {
    const m = model();
    const target = nextCell({ rowId: from.pageId, columnId: from.propertyId }, key, {
      rowIds: m.layout.rowIds,
      columnIds: m.columns.map((column) => column.id),
      pageRows: Math.max(1, Math.floor((store.root?.clientHeight ?? 0) / m.layout.rowHeight) - 2),
    });
    if (target === null) return false;
    focus(target.rowId, target.columnId);
    return true;
  };

  return {
    activate: (pageId, propertyId, seed) => {
      if (!writable(propertyId)) return;
      const column = columnOf(propertyId)!;
      const kind = editorKind(column.type);
      if (kind === "toggle") {
        model().actions.editCell(
          pageId as SpacePageId,
          propertyId as SpacePropertyId,
          valueOf(pageId, propertyId) === true ? null : true,
        );
        return;
      }
      if (kind === "none") return;
      const current = store.current();
      if (current?.pageId === pageId && current.propertyId === propertyId) return;
      release?.();
      release = model().hold();
      store.start(pageId, propertyId, seed);
    },
    commit: (pageId, propertyId, value, move, reason) => {
      if (!sameValue(valueOf(pageId, propertyId), value))
        model().actions.editCell(pageId as SpacePageId, propertyId as SpacePropertyId, value);
      endEdit();
      if (reason === "blur") return;
      if (move === undefined) return focus(pageId, propertyId);
      const moved = navigate({ pageId, propertyId }, { key: "Tab", shift: move === "left" });
      if (!moved) focus(pageId, propertyId);
    },
    change: (pageId, propertyId, value) => {
      if (!sameValue(valueOf(pageId, propertyId), value))
        model().actions.editCell(pageId as SpacePageId, propertyId as SpacePropertyId, value);
    },
    notePages: (pages) => model().notePages(pages),
    close: (pageId, propertyId) => {
      endEdit();
      focus(pageId, propertyId);
    },
    focus,
    navigate,
    clear: (pageId, propertyId) => {
      if (writable(propertyId) && valueOf(pageId, propertyId) !== undefined)
        model().actions.editCell(pageId as SpacePageId, propertyId as SpacePropertyId, null);
    },
    copyText: (pageId, propertyId) =>
      cellCopyText(valueOf(pageId, propertyId), columnOf(propertyId)?.known ?? null, model().text),
    pasteText: (pageId, propertyId, text) => {
      const known = columnOf(propertyId)?.known;
      if (!writable(propertyId) || known === undefined || known === null) return;
      const parsed = parseCell(text, known);
      if (parsed.ok && !sameValue(valueOf(pageId, propertyId), parsed.value))
        model().actions.editCell(
          pageId as SpacePageId,
          propertyId as SpacePropertyId,
          parsed.value,
        );
    },
    open: (pageId, mode) => model().actions.openRow(pageId as SpacePageId, mode),
    trash: (pageId) => {
      void model().actions.trashRow(pageId as SpacePageId);
    },
    addRow: (group) => {
      if (adding || !model().canAdd) return;
      adding = true;
      const groupId = group === null ? "" : canonicalJson(group);
      store.setAdding(groupId);
      // Held from before the request: its structural ack refreshes the loaded rows.
      const held = model().hold();
      void (async () => {
        try {
          const row = await model().actions.createRow({ cells: model().newRowCells(group) });
          if (row === null) return held();
          model().placeRow(row, group);
          release?.();
          release = held;
          store.start(row.page.id, "title");
        } catch (failure) {
          held();
          throw failure;
        } finally {
          adding = false;
          store.setAdding(null);
        }
      })();
    },
    toggleRow: (pageId, expand) => {
      const m = model();
      const item = m.layout.items[m.layout.itemIndexByRow.get(pageId) ?? -1];
      if (item?.kind !== "row") return false;
      const want = expand ?? item.expanded !== true;
      if (want ? item.expanded === true || item.expandable !== true : item.expanded !== true)
        return false;
      m.setExpanded(pageId, want);
      return true;
    },
    addSubItem: (parentId) => {
      const m = model();
      if (m.subItems === null || !m.canAdd) return;
      m.setExpanded(parentId, true);
      void m.actions
        .createRow({ cells: subItemCells(m.subItems.parentPropertyId, parentId as SpacePageId) })
        .then((row) => {
          if (row !== null) store.start(row.page.id, "title");
        });
    },
    loadChildren: (parentId) => model().loadChildren(parentId),
    get canSubItems() {
      return model().subItems !== null;
    },
    toggleGroup: (id) => model().toggleGroup(id),
    loadBucket: (key) => model().loadBucket(key),
    pageRows: () =>
      Math.max(1, Math.floor((store.root?.clientHeight ?? 0) / model().layout.rowHeight) - 2),
  };
}
