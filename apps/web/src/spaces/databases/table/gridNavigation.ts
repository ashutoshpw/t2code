export interface CellPosition {
  readonly rowId: string;
  readonly columnId: string;
}

export interface NavigationKey {
  readonly key: string;
  readonly shift?: boolean;
  readonly mod?: boolean;
}

export interface NavigationBounds {
  readonly rowIds: ReadonlyArray<string>;
  readonly columnIds: ReadonlyArray<string>;
  /** Rows a PageUp or PageDown moves. */
  readonly pageRows: number;
}

/** The cell a navigation key leads to, or null when the key does not move or hits an edge. */
export function nextCell(
  position: CellPosition,
  input: NavigationKey,
  bounds: NavigationBounds,
): CellPosition | null {
  const { rowIds, columnIds } = bounds;
  const row = rowIds.indexOf(position.rowId);
  const column = columnIds.indexOf(position.columnId);
  if (row < 0 || column < 0) return null;
  const lastRow = rowIds.length - 1;
  const lastColumn = columnIds.length - 1;
  const at = (r: number, c: number): CellPosition | null => {
    const rowId = rowIds[r];
    const columnId = columnIds[c];
    if (rowId === undefined || columnId === undefined) return null;
    return rowId === position.rowId && columnId === position.columnId ? null : { rowId, columnId };
  };
  switch (input.key) {
    case "ArrowUp":
      return row > 0 ? at(row - 1, column) : null;
    case "ArrowDown":
      return row < lastRow ? at(row + 1, column) : null;
    case "ArrowLeft":
      return column > 0 ? at(row, column - 1) : null;
    case "ArrowRight":
      return column < lastColumn ? at(row, column + 1) : null;
    case "Tab":
      if (input.shift === true) {
        if (column > 0) return at(row, column - 1);
        return row > 0 ? at(row - 1, lastColumn) : null;
      }
      if (column < lastColumn) return at(row, column + 1);
      return row < lastRow ? at(row + 1, 0) : null;
    case "Home":
      return input.mod === true ? at(0, 0) : at(row, 0);
    case "End":
      return input.mod === true ? at(lastRow, lastColumn) : at(row, lastColumn);
    case "PageUp":
      return at(Math.max(0, row - Math.max(1, bounds.pageRows)), column);
    case "PageDown":
      return at(Math.min(lastRow, row + Math.max(1, bounds.pageRows)), column);
    default:
      return null;
  }
}
