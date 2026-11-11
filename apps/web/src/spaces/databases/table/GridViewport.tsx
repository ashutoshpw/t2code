import { useState, type CSSProperties, type FocusEvent, type ReactNode, type UIEvent } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceAggregateResult, SpaceGroupBucket } from "@t2code/contracts/spaces";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import type { DatabaseLayout } from "../blocks/DatabaseBlockHost";
import { AggregateRow } from "./AggregateRow";
import { columnVar } from "./columnResize";
import { AddRow, GroupHeaderRow, MoreRow, SkeletonRow } from "./FooterRows";
import { cellOf, handleGridCopy, handleGridKeyDown, handleGridPaste } from "./gridKeys";
import type { GridEditStore } from "./gridEditStore";
import type { GridLayout } from "./gridItems";
import { columnRange, itemAt, rowRange, sameRange } from "./gridWindow";
import type { GroupLabel } from "./groupLabel";
import { ADD_COLUMN_WIDTH, HeaderRow } from "./HeaderRow";
import { TableRow } from "./TableRow";
import type { GridHandlers, OptionHint, TableColumn } from "./tableTypes";

const NEAR_END_ROWS = 10;
const INITIAL_SIZE = { w: 960, h: 600 };

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);

export interface GridViewportProps {
  readonly layout: GridLayout;
  /** Visible columns, title first. */
  readonly columns: ReadonlyArray<TableColumn>;
  readonly relatedPages: Parameters<typeof TableRow>[0]["relatedPages"];
  readonly optionHint: OptionHint;
  readonly timeZone: string;
  readonly environmentId: EnvironmentId;
  readonly spaceId: string;
  readonly canEdit: boolean;
  readonly canTrash: boolean;
  readonly canSchema: boolean;
  readonly canViews: boolean;
  readonly store: GridEditStore;
  readonly grid: GridHandlers;
  readonly aggregates: ReadonlyArray<SpaceAggregateResult>;
  readonly aggregateOf: (id: string) => string | undefined;
  readonly total: number | undefined;
  readonly ariaRowCount: number;
  readonly busy: boolean;
  readonly pageLayout: DatabaseLayout;
  readonly labelOf: (bucket: SpaceGroupBucket) => GroupLabel;
  readonly onNearEnd: () => void;
  readonly below: ReactNode;
}

/** The scroller: sticky header, title column and footer, with rows and columns windowed by scroll offset. */
export function GridViewport(props: GridViewportProps) {
  const { layout, columns, store, grid } = props;
  const [size, setSize] = useState(INITIAL_SIZE);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const [attach] = useState(() => (element: HTMLDivElement | null) => {
    store.attach(element);
    if (element === null) return;
    const measure = () =>
      setSize((previous) =>
        previous.w === element.clientWidth && previous.h === element.clientHeight
          ? previous
          : { w: element.clientWidth, h: element.clientHeight },
      );
    measure();
    return observeResize(element, measure);
  });

  const titleColumn = columns[0]!;
  const others = columns.slice(1);
  const widths = others.map((column) => column.width);
  const totalWidth = titleColumn.width + sum(widths) + ADD_COLUMN_WIDTH;
  const rows = rowRange(layout.offsets, layout.total, scroll.top, size.h);
  const cols = columnRange(widths, titleColumn.width, scroll.left, size.w);
  const leftSpace = sum(widths.slice(0, cols.first));

  const indices: number[] = [];
  for (let index = rows.first; index < rows.last; index += 1) indices.push(index);
  const focused = focusRow === null ? undefined : layout.itemIndexByRow.get(focusRow);
  if (focused !== undefined && (focused < rows.first || focused >= rows.last)) {
    // The row holding focus stays mounted so scrolling never drops it.
    if (focused < rows.first) indices.unshift(focused);
    else indices.push(focused);
  }

  const cssVars: Record<string, string> = {};
  for (const column of columns) cssVars[columnVar(column.id)] = `${column.width}px`;

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollLeft, clientHeight, clientWidth } = event.currentTarget;
    const nextRows = rowRange(layout.offsets, layout.total, scrollTop, clientHeight);
    const nextCols = columnRange(widths, titleColumn.width, scrollLeft, clientWidth);
    if (!sameRange(nextRows, rows) || !sameRange(nextCols, cols))
      setScroll({ top: scrollTop, left: scrollLeft });
    const lastVisible = itemAt(layout.offsets, Math.min(layout.total, scrollTop + clientHeight));
    if (layout.items.length - 1 - lastVisible <= NEAR_END_ROWS) props.onNearEnd();
  };

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      if (store.takeParked()) return;
      const first = layout.rowIds[0];
      const last = store.lastCell();
      if (last !== null && layout.itemIndexByRow.has(last.pageId))
        grid.focus(last.pageId, last.propertyId);
      else if (first !== undefined) grid.focus(first, "title");
      return;
    }
    const cell = cellOf(event);
    if (cell === null) return;
    store.rememberCell(cell);
    if (cell.pageId !== focusRow) setFocusRow(cell.pageId);
  };

  const renderItem = (index: number) => {
    const item = layout.items[index]!;
    const top = layout.offsets[index]!;
    const ariaRow = index + 2;
    switch (item.kind) {
      case "row":
        return (
          <TableRow
            key={item.row.page.id}
            row={item.row}
            titleColumn={titleColumn}
            columns={others}
            firstColumn={cols.first}
            lastColumn={cols.last}
            leftSpace={leftSpace}
            top={top}
            ariaRow={ariaRow}
            relatedPages={props.relatedPages}
            optionHint={props.optionHint}
            timeZone={props.timeZone}
            environmentId={props.environmentId}
            spaceId={props.spaceId}
            canEdit={props.canEdit}
            canTrash={props.canTrash}
            store={store}
            grid={grid}
          />
        );
      case "group":
        return (
          <GroupHeaderRow
            key={`g:${item.id}`}
            id={item.id}
            bucket={item.bucket}
            label={props.labelOf(item.bucket)}
            collapsed={item.collapsed}
            top={top}
            ariaRow={ariaRow}
            grid={grid}
          />
        );
      case "add":
        return (
          <AddRow
            key={`add:${index}`}
            group={item.group}
            top={top}
            ariaRow={ariaRow}
            store={store}
            grid={grid}
          />
        );
      case "more":
        return (
          <MoreRow
            key={`more:${index}`}
            group={item.group}
            loading={item.loading}
            top={top}
            ariaRow={ariaRow}
            grid={grid}
          />
        );
      case "skeleton":
        return <SkeletonRow key={`s:${index}`} top={top} ariaRow={ariaRow} />;
    }
  };

  return (
    <div
      ref={attach}
      role="grid"
      aria-label="Rows"
      aria-rowcount={props.ariaRowCount}
      aria-colcount={columns.length + 1}
      aria-busy={props.busy}
      tabIndex={0}
      data-grid-root=""
      style={cssVars as CSSProperties}
      className={cn(
        "relative overflow-auto overscroll-contain rounded-lg border bg-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.pageLayout === "page" ? "h-[calc(100dvh-15rem)] min-h-80" : "max-h-[min(36rem,70vh)]",
      )}
      onScroll={onScroll}
      onFocus={onFocus}
      onKeyDown={(event) => handleGridKeyDown(event, grid, store)}
      onCopy={(event) => handleGridCopy(event, grid)}
      onPaste={(event) => handleGridPaste(event, grid)}
    >
      <HeaderRow
        columns={columns}
        canSchema={props.canSchema}
        canViews={props.canViews}
        totalWidth={totalWidth}
      />
      <div
        role="presentation"
        className="relative"
        style={{ height: layout.total, width: totalWidth }}
      >
        {indices.map(renderItem)}
      </div>
      {props.below}
      <AggregateRow
        columns={columns}
        aggregates={props.aggregates}
        total={props.total}
        canEdit={props.canViews}
        timeZone={props.timeZone}
        totalWidth={totalWidth}
        ariaRow={props.ariaRowCount}
        aggregateOf={props.aggregateOf}
      />
    </div>
  );
}
