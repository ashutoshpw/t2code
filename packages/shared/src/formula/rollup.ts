import { normalizeZone } from "./dates.ts";
import { medianOf } from "./numbers.ts";
import { type FormulaType, farify, isListType } from "./types.ts";
import {
  type DateValue,
  type FormulaValue,
  effectiveEnd,
  instantOf,
  isDateValue,
  isEmptyValue,
  isListValue,
  num,
  valueKey,
} from "./values.ts";

export type RollupFunction =
  | "show_original"
  | "show_unique"
  | "count_all"
  | "count_values"
  | "count_unique"
  | "count_empty"
  | "count_not_empty"
  | "percent_empty"
  | "percent_not_empty"
  | "sum"
  | "average"
  | "median"
  | "min"
  | "max"
  | "range"
  | "earliest_date"
  | "latest_date"
  | "date_range"
  | "checked"
  | "unchecked"
  | "percent_checked"
  | "percent_unchecked";

const GENERIC: ReadonlyArray<RollupFunction> = [
  "show_original",
  "show_unique",
  "count_all",
  "count_values",
  "count_unique",
  "count_empty",
  "count_not_empty",
  "percent_empty",
  "percent_not_empty",
];
const NUMERIC: ReadonlyArray<RollupFunction> = ["sum", "average", "median", "min", "max", "range"];
const DATES: ReadonlyArray<RollupFunction> = ["earliest_date", "latest_date", "date_range"];
const BOOLEANS: ReadonlyArray<RollupFunction> = [
  "checked",
  "unchecked",
  "percent_checked",
  "percent_unchecked",
];

const elementOfTarget = (target: FormulaType): FormulaType =>
  isListType(target) ? target.list : target;

function kindOf(target: FormulaType): "number" | "date" | "boolean" | "other" {
  const e = elementOfTarget(target);
  if (e === "number") return "number";
  if (e === "date") return "date";
  return target === "boolean" ? "boolean" : "other";
}

export function rollupFunctionsFor(target: FormulaType): ReadonlyArray<RollupFunction> {
  switch (kindOf(target)) {
    case "number":
      return [...GENERIC, ...NUMERIC];
    case "date":
      return [...GENERIC, ...DATES];
    case "boolean":
      return [...GENERIC, ...BOOLEANS];
    default:
      return GENERIC;
  }
}

export function rollupResultType(fn: RollupFunction, target: FormulaType): FormulaType | null {
  if (!rollupFunctionsFor(target).includes(fn)) return null;
  if (fn === "show_original" || fn === "show_unique") {
    const e = elementOfTarget(target);
    return { list: e === "empty" ? "any" : farify(e) };
  }
  if (DATES.includes(fn)) return "date";
  return "number";
}

const ratio = (count: number, total: number): number | null => (total === 0 ? null : count / total);

function single(d: DateValue, value: number): DateValue {
  return {
    kind: "date",
    start: value,
    timed: d.timed,
    ...(d.zone === undefined ? {} : { zone: d.zone }),
  };
}

function dateResult(
  fn: "earliest_date" | "latest_date" | "date_range",
  dates: ReadonlyArray<DateValue>,
  tz: string,
): FormulaValue {
  let first: DateValue | undefined;
  let last: DateValue | undefined;
  for (const d of dates) {
    if (first === undefined || instantOf(d, d.start, tz) < instantOf(first, first.start, tz))
      first = d;
    if (
      last === undefined ||
      instantOf(d, effectiveEnd(d), tz) > instantOf(last, effectiveEnd(last), tz)
    )
      last = d;
  }
  if (first === undefined || last === undefined) return null;
  if (fn === "earliest_date") return single(first, first.start);
  if (fn === "latest_date") return single(last, effectiveEnd(last));
  const startInstant = instantOf(first, first.start, tz);
  const endInstant = instantOf(last, effectiveEnd(last), tz);
  if (startInstant === endInstant) return single(first, first.start);
  if (!first.timed && !last.timed)
    return { ...single(first, first.start), end: effectiveEnd(last) };
  return { kind: "date", start: startInstant, end: endInstant, timed: true };
}

export function evaluateRollup(
  fn: RollupFunction,
  perPage: ReadonlyArray<FormulaValue>,
  target: FormulaType,
  context: { readonly timeZone: string },
): FormulaValue {
  if (!rollupFunctionsFor(target).includes(fn)) return null;
  const tz = normalizeZone(context.timeZone);
  const items = perPage.flatMap((v) => (isListValue(v) ? v : [v])).filter((v) => v !== null);
  const numbers = items.filter((v): v is number => typeof v === "number");
  const pages = perPage.length;
  const empties = perPage.filter((v) => isEmptyValue(v) && v !== 0).length;
  switch (fn) {
    case "show_original":
      return items;
    case "show_unique": {
      const seen = new Set<string>();
      return items.filter((v) => {
        const key = valueKey(v, tz);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    case "count_all":
      return pages;
    case "count_values":
      return items.length;
    case "count_unique":
      return new Set(items.map((v) => valueKey(v, tz))).size;
    case "count_empty":
      return empties;
    case "count_not_empty":
      return pages - empties;
    case "percent_empty":
      return ratio(empties, pages);
    case "percent_not_empty":
      return ratio(pages - empties, pages);
    case "sum":
      return num(numbers.reduce((a, b) => a + b, 0));
    case "average":
      return numbers.length === 0 ? null : num(numbers.reduce((a, b) => a + b, 0) / numbers.length);
    case "median":
      return medianOf([...numbers].sort((a, b) => a - b));
    case "min":
      return numbers.length === 0 ? null : num(Math.min(...numbers));
    case "max":
      return numbers.length === 0 ? null : num(Math.max(...numbers));
    case "range":
      return numbers.length === 0 ? null : num(Math.max(...numbers) - Math.min(...numbers));
    case "earliest_date":
    case "latest_date":
    case "date_range":
      return dateResult(fn, items.filter(isDateValue), tz);
    case "checked":
      return perPage.filter((v) => v === true).length;
    case "unchecked":
      return perPage.filter((v) => v !== true).length;
    case "percent_checked":
      return ratio(perPage.filter((v) => v === true).length, pages);
    case "percent_unchecked":
      return ratio(perPage.filter((v) => v !== true).length, pages);
  }
}
