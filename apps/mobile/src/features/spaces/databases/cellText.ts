import {
  cellPlainText,
  computedInfoOf,
  knownComputedValue,
  rowTitle,
  type CellTextContext,
} from "@t2code/client-runtime/spaces";
import {
  SpacePageId,
  type SpaceCellValue,
  type SpaceDatabaseProperty,
  type SpaceDatabaseRow,
  type SpaceKnownDatabaseProperty,
} from "@t2code/contracts/spaces";

export interface LineChip {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

export interface LineRelation {
  readonly pageId: SpacePageId;
  readonly title: string;
  readonly dataSourceId: string | undefined;
}

/** One property of a row, as a phone shows it: a name and a value, never an editor. */
export interface CardLine {
  readonly propertyId: string;
  readonly name: string;
  readonly text: string;
  readonly chips?: ReadonlyArray<LineChip>;
  readonly checked?: boolean;
  readonly related?: ReadonlyArray<LineRelation>;
  /** A property or computed value this version of the app does not know how to show. */
  readonly unsupported?: boolean;
  /** A formula or rollup the server could not evaluate. */
  readonly error?: boolean;
}

export interface LineColumn {
  readonly property: SpaceDatabaseProperty;
  readonly known: SpaceKnownDatabaseProperty | null;
}

export const rowDisplayTitle = (row: SpaceDatabaseRow): string =>
  rowTitle(row) || row.page.title || "Untitled";

const ids = (value: SpaceCellValue | undefined): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

function chipsOf(
  known: Extract<SpaceKnownDatabaseProperty, { type: "select" | "multi_select" | "status" }>,
  value: SpaceCellValue | undefined,
  context: CellTextContext,
): ReadonlyArray<LineChip> {
  const optionIds =
    known.type === "multi_select" ? ids(value) : typeof value === "string" ? [value] : [];
  return optionIds.flatMap((id) => {
    const option = known.config.options.find((entry) => entry.id === id);
    const hint = option === undefined ? context.optionHint(known.id, id) : undefined;
    const name = option?.name ?? hint?.name;
    return name === undefined
      ? []
      : [{ id, name, color: option?.color ?? hint?.color ?? "default" }];
  });
}

/**
 * The value of one cell. Null when the cell is empty (a card leaves empty properties out). Unknown
 * property types and computed values of a shape this client does not know read as "Unsupported";
 * a formula or rollup the server flagged reads as "Error"; one the server never compiled reads as empty.
 */
export function cardLine(
  row: SpaceDatabaseRow,
  column: LineColumn,
  context: CellTextContext,
): CardLine | null {
  const { property, known } = column;
  const base = { propertyId: property.id, name: property.name };
  const value = row.cells[property.id];
  if (known === null) return { ...base, text: "Unsupported", unsupported: true };
  switch (known.type) {
    case "formula":
    case "rollup": {
      const info = computedInfoOf(known);
      if (info?.error !== undefined) return { ...base, text: "Error", error: true };
      if (value === undefined || value === null) return null;
      if (knownComputedValue(value) === undefined)
        return { ...base, text: "Unsupported", unsupported: true };
      const text = cellPlainText(value, known, context);
      return text === "" ? null : { ...base, text };
    }
    case "checkbox":
      return { ...base, text: "", checked: value === true };
    case "select":
    case "status":
    case "multi_select": {
      const chips = chipsOf(known, value, context);
      return chips.length === 0
        ? null
        : { ...base, text: chips.map((chip) => chip.name).join(", "), chips };
    }
    case "relation": {
      const related = ids(value).map((pageId) => ({
        pageId: SpacePageId.make(pageId),
        title: context.relatedPages[pageId]?.title || "Untitled",
        dataSourceId: context.relatedPages[pageId]?.dataSourceId,
      }));
      return related.length === 0
        ? null
        : { ...base, text: related.map((entry) => entry.title).join(", "), related };
    }
    default: {
      const text = cellPlainText(value, known, context);
      return text === "" ? null : { ...base, text };
    }
  }
}

/** The non-empty lines of a row for the given columns, in column order. */
export function cardLines(
  row: SpaceDatabaseRow,
  columns: ReadonlyArray<LineColumn>,
  context: CellTextContext,
): ReadonlyArray<CardLine> {
  return columns.flatMap((column) => {
    const line = cardLine(row, column, context);
    return line === null ? [] : [line];
  });
}
