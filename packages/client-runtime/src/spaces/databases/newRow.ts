import type {
  SpaceCellValue,
  SpaceDatabaseProperty,
  SpaceFilter,
  SpaceKnownDatabaseProperty,
  SpaceKnownGroupKey,
  SpaceOptionId,
  SpacePropertyId,
  SpaceStatusGroup,
} from "@t2code/contracts/spaces";
import { knownProperty } from "./schema.ts";

function statusOptionInGroup(
  known: Extract<SpaceKnownDatabaseProperty, { type: "status" }>,
  group: SpaceStatusGroup,
): SpaceOptionId | undefined {
  const { options, defaultOptionId } = known.config;
  const preferred = options.find(
    (option) => option.id === defaultOptionId && option.group === group,
  );
  return (preferred ?? options.find((option) => option.group === group))?.id;
}

/**
 * The cell a row needs to land in a bucket. `undefined` means the grouping cannot be written
 * (ranges, week/month/year dates, alphabetical text); `null` means leave the cell empty.
 */
export function cellForGroupKey(
  key: SpaceKnownGroupKey,
  known: SpaceKnownDatabaseProperty,
): SpaceCellValue | null | undefined {
  switch (key.kind) {
    case "empty":
      return null;
    case "option":
      if (known.type === "select" || known.type === "status") return key.optionId;
      if (known.type === "multi_select") return [key.optionId];
      return undefined;
    case "status_group": {
      if (known.type !== "status") return undefined;
      return statusOptionInGroup(known, key.group) ?? null;
    }
    case "checkbox":
      return known.type === "checkbox" ? (key.value ? true : null) : undefined;
    case "text":
      if (
        known.type === "title" ||
        known.type === "url" ||
        known.type === "email" ||
        known.type === "phone"
      )
        return key.value;
      if (known.type === "text") return [{ text: key.value, marks: [] }];
      return undefined;
    case "date":
      return known.type === "date" && key.unit === "day" ? { start: key.start } : undefined;
    case "page":
      return known.type === "relation" ? [key.pageId] : undefined;
    case "number_range":
      return undefined;
  }
}

const shiftDay = (day: string, delta: number): string => {
  // @effect-diagnostics-next-line globalDate:off
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
};

function conditionCell(
  known: SpaceKnownDatabaseProperty,
  operator: string,
  value: unknown,
  today: string,
): SpaceCellValue | undefined {
  switch (known.type) {
    case "title":
    case "url":
    case "email":
    case "phone":
      return ["equals", "contains", "starts_with", "ends_with"].includes(operator) &&
        typeof value === "string"
        ? value
        : undefined;
    case "text":
      return ["equals", "contains", "starts_with", "ends_with"].includes(operator) &&
        typeof value === "string"
        ? [{ text: value, marks: [] }]
        : undefined;
    case "number":
      return operator === "equals" && typeof value === "number" ? value : undefined;
    case "checkbox":
      return operator === "equals" && value === true ? true : undefined;
    case "select":
    case "status":
      if (operator === "equals" && typeof value === "string") return value;
      if (known.type === "status" && operator === "in_group" && typeof value === "string")
        return statusOptionInGroup(known, value as SpaceStatusGroup);
      return undefined;
    case "multi_select":
      return operator === "contains" && typeof value === "string" ? [value] : undefined;
    case "relation":
      return operator === "contains" && typeof value === "string" ? [value] : undefined;
    case "date": {
      if (operator !== "equals") return undefined;
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { start: value };
      if (typeof value === "object" && value !== null && "relative" in value) {
        const delta = { today: 0, tomorrow: 1, yesterday: -1 }[String(value.relative)];
        return delta === undefined ? undefined : { start: shiftDay(today, delta) };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Cells a new row gets so it stays visible in the view that created it: values implied by `and`
 * conditions of the filter, then the bucket value of the group (which wins).
 */
export function newRowCells(input: {
  readonly filter: SpaceFilter | undefined;
  readonly properties: Readonly<Record<string, SpaceDatabaseProperty>>;
  readonly group?: { readonly property: SpacePropertyId; readonly key: SpaceKnownGroupKey };
  readonly today: string;
}): Record<string, SpaceCellValue> {
  const cells: Record<string, SpaceCellValue> = {};
  const visit = (filter: SpaceFilter | undefined) => {
    if (filter === undefined) return;
    if ("or" in filter) return;
    if ("and" in filter) {
      for (const child of filter.and) visit(child);
      return;
    }
    const property = input.properties[filter.property];
    const known = property === undefined ? null : knownProperty(property);
    if (known === null) return;
    const cell = conditionCell(known, filter.operator, filter.value, input.today);
    if (cell !== undefined) cells[known.id] = cell;
  };
  visit(input.filter);
  if (input.group !== undefined) {
    const property = input.properties[input.group.property];
    const known = property === undefined ? null : knownProperty(property);
    if (known !== null) {
      const cell = cellForGroupKey(input.group.key, known);
      if (cell === null) delete cells[known.id];
      else if (cell !== undefined) cells[known.id] = cell;
    }
  }
  return cells;
}
