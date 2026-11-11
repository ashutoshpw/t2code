import type { EnvironmentId } from "@t2code/contracts";
import type { OptionHint } from "@t2code/client-runtime/spaces";
import type {
  SpaceCellValue,
  SpaceGroupKey,
  SpaceKnownDatabaseProperty,
  SpacePropertyId,
  SpaceRelatedPage,
} from "@t2code/contracts/spaces";

import type { RowOpenMode } from "../data/actions";
import type { NavigationKey } from "./gridNavigation";

export type { OptionHint };

export interface TableColumn {
  readonly id: SpacePropertyId;
  readonly name: string;
  readonly known: SpaceKnownDatabaseProperty | null;
  readonly type: string;
  /** Pixels, within the column limits. */
  readonly width: number;
  /** False for types no editor exists for. */
  readonly writable: boolean;
  /** Cells show up to three lines. */
  readonly wrap: boolean;
}

export interface CellPoint {
  readonly pageId: string;
  readonly propertyId: string;
}

/** The stable surface cells, rows and the grid root call into; every method reads the latest model. */
export interface GridHandlers {
  activate(pageId: string, propertyId: string, seed?: string): void;
  commit(
    pageId: string,
    propertyId: string,
    value: SpaceCellValue | null,
    move?: "right" | "left",
    reason?: "blur",
  ): void;
  change(pageId: string, propertyId: string, value: SpaceCellValue | null): void;
  notePages(pages: Readonly<Record<string, SpaceRelatedPage>>): void;
  close(pageId: string, propertyId: string): void;
  focus(pageId: string, propertyId: string): void;
  /** True when the key moved focus to another cell. */
  navigate(from: CellPoint, key: NavigationKey): boolean;
  clear(pageId: string, propertyId: string): void;
  copyText(pageId: string, propertyId: string): string;
  pasteText(pageId: string, propertyId: string, text: string): void;
  open(pageId: string, mode?: RowOpenMode): void;
  trash(pageId: string): void;
  addRow(group: SpaceGroupKey | null): void;
  toggleGroup(id: string): void;
  loadBucket(key: SpaceGroupKey): void;
  /** Expands or collapses a row's sub-items; true when the key changed something. */
  toggleRow(pageId: string, expand?: boolean): boolean;
  addSubItem(parentId: string): void;
  loadChildren(parentId: string): void;
  /** Whether the row menu offers `Add sub-item`. */
  readonly canSubItems: boolean;
  /** Rows a page key moves. */
  pageRows(): number;
}

export interface CellContext {
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  readonly optionHint: OptionHint;
  readonly timeZone: string;
  readonly environmentId: EnvironmentId;
}

const sameColumn = (a: TableColumn, b: TableColumn) =>
  a === b ||
  (a.id === b.id &&
    a.name === b.name &&
    a.type === b.type &&
    a.width === b.width &&
    a.writable === b.writable &&
    a.wrap === b.wrap &&
    a.known === b.known);

/**
 * Shallow props equality for memoized rows and cells, with columns compared by content: the
 * column objects are rebuilt whenever the view re-renders, and that must not re-render every row.
 */
export function sameRowProps<P extends object>(a: P, b: P): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of Object.keys(left)) {
    const x = left[key];
    const y = right[key];
    if (x === y) continue;
    if (key === "column" || key === "titleColumn") {
      if (!sameColumn(x as TableColumn, y as TableColumn)) return false;
    } else if (key === "columns") {
      const xs = x as ReadonlyArray<TableColumn>;
      const ys = y as ReadonlyArray<TableColumn>;
      if (xs.length !== ys.length || !xs.every((column, index) => sameColumn(column, ys[index]!)))
        return false;
    } else return false;
  }
  return true;
}
