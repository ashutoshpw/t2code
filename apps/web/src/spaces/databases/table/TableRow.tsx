import { memo } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceCellValue, SpaceDatabaseRow, SpaceRelatedPage } from "@t2code/contracts/spaces";

import type { GridEditStore } from "./gridEditStore";
import { TableCell } from "./TableCell";
import { sameRowProps, type GridHandlers, type OptionHint, type TableColumn } from "./tableTypes";

export interface TableRowProps {
  readonly row: SpaceDatabaseRow;
  readonly titleColumn: TableColumn;
  /** Visible columns after the title. */
  readonly columns: ReadonlyArray<TableColumn>;
  readonly firstColumn: number;
  readonly lastColumn: number;
  /** Width of the columns before `firstColumn`. */
  readonly leftSpace: number;
  readonly top: number;
  readonly rowHeight: number;
  readonly depth: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly ariaRow: number;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  readonly optionHint: OptionHint;
  readonly timeZone: string;
  readonly environmentId: EnvironmentId;
  readonly spaceId: string;
  readonly canEdit: boolean;
  readonly canTrash: boolean;
  readonly store: GridEditStore;
  readonly grid: GridHandlers;
}

/** Cells the server computes but may not echo back in `cells`. */
function cellValue(row: SpaceDatabaseRow, column: TableColumn): SpaceCellValue | undefined {
  const stored = row.cells[column.id];
  if (stored !== undefined) return stored;
  switch (column.type) {
    case "created_time":
      return row.page.createdAt;
    case "last_edited_time":
      return row.page.updatedAt;
    case "unique_id": {
      const prefix = (column.known?.config as { prefix?: string } | undefined)?.prefix;
      return { number: row.number, ...(prefix === undefined ? {} : { prefix }) };
    }
    default:
      return undefined;
  }
}

export const TableRow = memo(function TableRow({
  row,
  titleColumn,
  columns,
  firstColumn,
  lastColumn,
  leftSpace,
  top,
  rowHeight,
  depth,
  expandable,
  expanded,
  ariaRow,
  relatedPages,
  optionHint,
  timeZone,
  environmentId,
  spaceId,
  canEdit,
  canTrash,
  store,
  grid,
}: TableRowProps) {
  const shared = {
    pageId: row.page.id,
    relatedPages,
    optionHint,
    timeZone,
    environmentId,
    spaceId,
    canTrash,
    store,
    grid,
  };
  return (
    <div
      role="row"
      aria-rowindex={ariaRow}
      className="group/row absolute start-0 flex w-full border-b border-border/60 hover:bg-accent/30"
      style={{ top, height: rowHeight }}
    >
      <TableCell
        {...shared}
        column={titleColumn}
        colIndex={1}
        depth={depth}
        expandable={expandable}
        expanded={expanded}
        value={cellValue(row, titleColumn)}
        editable={canEdit && titleColumn.writable}
      />
      {leftSpace > 0 ? (
        <span aria-hidden className="shrink-0" style={{ width: leftSpace }} />
      ) : null}
      {columns.slice(firstColumn, lastColumn).map((column, offset) => (
        <TableCell
          key={column.id}
          {...shared}
          column={column}
          colIndex={firstColumn + offset + 2}
          value={cellValue(row, column)}
          editable={canEdit && column.writable}
        />
      ))}
    </div>
  );
}, sameRowProps);
