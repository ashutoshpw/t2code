import {
  evaluate,
  formatValue,
  type CompiledFormula,
  type FormulaValue,
} from "@t2code/shared/formula";
import type {
  SpaceCellMap,
  SpaceCellValue,
  SpaceDataSource,
  SpaceDatabaseProperty,
  SpaceRelatedPage,
} from "@t2code/contracts/spaces";

type JsonObject = Readonly<Record<string, SpaceCellValue>>;
function objectOf(value: SpaceCellValue | undefined): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function dateOf(value: SpaceCellValue): FormulaValue {
  const object = objectOf(value);
  if (object === null) return null;
  const start = typeof object["start"] === "string" ? object["start"] : null;
  if (start === null) return null;
  const end = typeof object["end"] === "string" ? object["end"] : undefined;
  const parse = (text: string): { ms: number; timed: boolean } | null => {
    const day = DAY_ONLY.exec(text);
    if (day !== null) return { ms: Date.UTC(+day[1]!, +day[2]! - 1, +day[3]!), timed: false };
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : { ms, timed: true };
  };
  const first = parse(start);
  if (first === null) return null;
  const last = end === undefined ? null : parse(end);
  return {
    kind: "date",
    start: first.ms,
    ...(last === null ? {} : { end: last.ms }),
    timed: first.timed,
    ...(typeof object["timeZone"] === "string" ? { zone: object["timeZone"] } : {}),
  };
}

function computedOf(cell: SpaceCellValue | undefined): FormulaValue {
  const value = objectOf(cell);
  if (value === null) return null;
  const inner = value["value"];
  switch (value["type"]) {
    case "string":
      return typeof inner === "string" ? inner : null;
    case "number":
      return typeof inner === "number" ? inner : null;
    case "boolean":
      return typeof inner === "boolean" ? inner : null;
    case "date":
      return inner === undefined ? null : dateOf(inner);
    case "page":
      return typeof inner === "string"
        ? {
            kind: "page",
            id: inner,
            ds: typeof value["dataSourceId"] === "string" ? value["dataSourceId"] : "",
          }
        : null;
    case "array":
      return Array.isArray(inner) ? inner.map((item) => computedOf(item)) : null;
    default:
      return null;
  }
}

const configOf = (property: SpaceDatabaseProperty): JsonObject => objectOf(property.config) ?? {};

function optionName(property: SpaceDatabaseProperty, id: SpaceCellValue): string | null {
  const options = configOf(property)["options"];
  if (!Array.isArray(options)) return null;
  for (const entry of options) {
    const option = objectOf(entry);
    if (option !== null && option["id"] === id)
      return typeof option["name"] === "string" ? option["name"] : null;
  }
  return null;
}

/** A stored cell as the formula engine reads it (plan table 1.4). Preview only; the server evaluates for real. */
export function cellAsFormulaValue(
  property: SpaceDatabaseProperty,
  cell: SpaceCellValue | undefined,
): FormulaValue {
  switch (property.type) {
    case "title":
    case "url":
    case "email":
    case "phone":
      return typeof cell === "string" && cell !== "" ? cell : null;
    case "text": {
      if (!Array.isArray(cell)) return null;
      const text = cell.map((run) => String(objectOf(run)?.["text"] ?? "")).join("");
      return text === "" ? null : text;
    }
    case "number":
      return typeof cell === "number" ? cell : null;
    case "checkbox":
      return cell === true;
    case "select":
    case "status":
      return cell === undefined || cell === null ? null : optionName(property, cell);
    case "multi_select":
      return Array.isArray(cell)
        ? cell.flatMap((id) => {
            const name = optionName(property, id);
            return name === null ? [] : [name];
          })
        : [];
    case "date":
      return cell === undefined || cell === null ? null : dateOf(cell);
    case "created_time":
    case "last_edited_time":
      return typeof cell === "string" ? dateOf({ start: cell }) : null;
    case "unique_id": {
      const id = objectOf(cell);
      return id === null
        ? null
        : `${typeof id["prefix"] === "string" ? `${id["prefix"]}-` : ""}${String(id["number"])}`;
    }
    case "files":
      return Array.isArray(cell)
        ? cell.flatMap((entry) => {
            const item = objectOf(entry);
            return item === null ? [] : [String(item["url"] ?? item["name"])];
          })
        : [];
    case "relation": {
      const ds = configOf(property)["dataSourceId"];
      return Array.isArray(cell)
        ? cell.flatMap((id) =>
            typeof id === "string" ? [{ kind: "page" as const, id, ds: String(ds) }] : [],
          )
        : [];
    }
    case "formula":
    case "rollup":
      return computedOf(cell);
    default:
      return null;
  }
}

export interface PreviewRow {
  readonly id: string;
  readonly title: string;
  readonly cells: SpaceCellMap;
}

/**
 * The text a compiled formula gives on one loaded row. Properties of related pages are not
 * loaded, so a formula that reads them has no preview (`null`).
 */
export function previewText(
  compiled: CompiledFormula,
  dataSource: SpaceDataSource,
  row: PreviewRow,
  options: {
    readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
    readonly now: number;
    readonly timeZone: string;
  },
): string | null {
  if (compiled.deps.related.some((entry) => entry.propertyIds.some((id) => id !== "title")))
    return null;
  const titleOf = (pageId: string) =>
    pageId === row.id ? row.title : options.relatedPages[pageId]?.title;
  const value = evaluate(compiled, {
    now: options.now,
    timeZone: options.timeZone,
    row: { id: row.id, dataSourceId: dataSource.id },
    read: (page, propertyId) => {
      if (page.id !== row.id) return propertyId === "title" ? (titleOf(page.id) ?? null) : null;
      const property = dataSource.properties[propertyId];
      return property === undefined
        ? null
        : cellAsFormulaValue(property, propertyId === "title" ? row.title : row.cells[propertyId]);
    },
    titleOf,
  });
  return formatValue(value, { timeZone: options.timeZone, titleOf });
}
