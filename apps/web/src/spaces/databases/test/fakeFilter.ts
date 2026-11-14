import type {
  SpaceDataSource,
  SpaceDatabaseQueryInput,
  SpaceDatabaseRow,
  SpaceFilter,
} from "@t2code/contracts/spaces";

/**
 * Just enough query semantics for the fake: date operators with `part`, emptiness, equality and a
 * date or title sort. Days compare as `YYYY-MM-DD` prefixes, which is what the views ask about.
 */

type Json = Record<string, unknown>;

const dayOf = (value: unknown, part: "start" | "end"): string | null => {
  if (typeof value === "string") return value.slice(0, 10);
  if (typeof value !== "object" || value === null) return null;
  const date = value as { start?: unknown; end?: unknown };
  const stamp = part === "end" ? (date.end ?? date.start) : date.start;
  return typeof stamp === "string" ? stamp.slice(0, 10) : null;
};

function cellOf(row: SpaceDatabaseRow, propertyId: string, dataSource: SpaceDataSource): unknown {
  const type = (dataSource.properties[propertyId] as { type?: string } | undefined)?.type;
  if (type === "created_time") return row.page.createdAt;
  if (type === "last_edited_time") return row.page.updatedAt;
  const cell = (row.cells as Json)[propertyId];
  // A computed cell is `{ type, value }`; filters and sorts see the value.
  return (type === "formula" || type === "rollup") && typeof cell === "object" && cell !== null
    ? (cell as { value?: unknown }).value
    : cell;
}

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

function condition(
  row: SpaceDatabaseRow,
  filter: { property: string; operator: string; value?: unknown; part?: "start" | "end" },
  dataSource: SpaceDataSource,
): boolean {
  const cell = cellOf(row, filter.property, dataSource);
  if (filter.operator === "is_empty") return isEmpty(cell);
  if (filter.operator === "is_not_empty") return !isEmpty(cell);
  if (typeof cell === "number" && typeof filter.value === "number") {
    switch (filter.operator) {
      case "equals":
        return cell === filter.value;
      case "does_not_equal":
        return cell !== filter.value;
      case "greater_than":
        return cell > filter.value;
      case "less_than":
        return cell < filter.value;
      case "greater_than_or_equal_to":
        return cell >= filter.value;
      case "less_than_or_equal_to":
        return cell <= filter.value;
    }
  }
  const day = dayOf(cell, filter.part ?? "start");
  const operand = typeof filter.value === "string" ? filter.value.slice(0, 10) : null;
  if (day === null || operand === null)
    return filter.operator === "equals" ? cell === filter.value : false;
  switch (filter.operator) {
    case "equals":
      return day === operand;
    case "before":
      return day < operand;
    case "after":
      return day > operand;
    case "on_or_before":
      return day <= operand;
    case "on_or_after":
      return day >= operand;
    default:
      return true;
  }
}

export function matchesFilter(
  row: SpaceDatabaseRow,
  filter: SpaceFilter | null | undefined,
  dataSource: SpaceDataSource,
): boolean {
  if (filter === undefined || filter === null) return true;
  if ("and" in filter) return filter.and.every((child) => matchesFilter(row, child, dataSource));
  if ("or" in filter) return filter.or.some((child) => matchesFilter(row, child, dataSource));
  return condition(row, filter, dataSource);
}

const sortKey = (value: unknown): string | null => {
  if (isEmpty(value)) return null;
  if (typeof value === "object" && value !== null && "start" in value)
    return String((value as { start: unknown }).start);
  return String(value);
};

/** Stable: rows with equal keys keep their order; empty values sort last in both directions. */
export function sortRows(
  rows: ReadonlyArray<SpaceDatabaseRow>,
  sorts: SpaceDatabaseQueryInput["sorts"],
  dataSource: SpaceDataSource,
): SpaceDatabaseRow[] {
  if (sorts === undefined || sorts.length === 0) return [...rows];
  const indexed = rows.map((row, index) => ({ row, index }));
  indexed.sort((a, b) => {
    for (const sort of sorts) {
      const left = sortKey(cellOf(a.row, sort.property, dataSource));
      const right = sortKey(cellOf(b.row, sort.property, dataSource));
      if (left === right) continue;
      if (left === null) return 1;
      if (right === null) return -1;
      const order = left < right ? -1 : 1;
      return sort.direction === "descending" ? -order : order;
    }
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.row);
}
