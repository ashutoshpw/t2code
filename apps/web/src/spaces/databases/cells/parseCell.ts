import type { SpaceCellValue, SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";

import { buildDateValue, parseTypedDay, EMPTY_DATE_DRAFT } from "./dateValue";

export type ParsedCell =
  | { readonly ok: true; readonly value: SpaceCellValue | null }
  | { readonly ok: false };

const FAIL: ParsedCell = { ok: false };
const done = (value: SpaceCellValue | null): ParsedCell => ({ ok: true, value });

/** Digits, sign, decimal point, exponent, grouping commas, a leading currency sign and a trailing percent. */
export function parseNumber(text: string, format: string): number | null | undefined {
  let value = text.trim().replace(/[\s,_]/g, "");
  if (value === "") return null;
  if (value.endsWith("%")) value = value.slice(0, -1);
  value = value.replace(/^([+-]?)[^\d.+-]+/u, "$1");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value)) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return format === "percent" ? Number((number / 100).toPrecision(12)) : number;
}

/** The number as typed in an editor: percent values are shown as whole percents. */
export function numberToText(value: number, format: string): string {
  return String(format === "percent" ? Number((value * 100).toPrecision(12)) : value);
}

type OptionKnown = Extract<
  SpaceKnownDatabaseProperty,
  { type: "select" | "multi_select" | "status" }
>;
const optionByName = (known: OptionKnown, name: string) => {
  const wanted = name.trim().toLowerCase();
  return known.config.options.find((option) => option.name.toLowerCase() === wanted);
};

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x", "checked"]);

/** Plain text (a pasted cell or a typed value) to the cell it stands for; never a partial value. */
export function parseCell(text: string, known: SpaceKnownDatabaseProperty): ParsedCell {
  const trimmed = text.trim();
  switch (known.type) {
    case "title":
    case "url":
    case "email":
    case "phone":
      return done(trimmed === "" ? null : trimmed);
    case "text":
      return done(trimmed === "" ? null : [{ text: trimmed, marks: [] }]);
    case "number": {
      const number = parseNumber(text, known.config.format);
      return number === undefined ? FAIL : done(number);
    }
    case "checkbox":
      return done(TRUE_WORDS.has(trimmed.toLowerCase()) ? true : null);
    case "select":
    case "status": {
      if (trimmed === "") return done(null);
      const option = optionByName(known, trimmed);
      return option === undefined ? FAIL : done(option.id);
    }
    case "multi_select": {
      if (trimmed === "") return done(null);
      const ids: string[] = [];
      for (const part of trimmed.split(",")) {
        const option = optionByName(known, part);
        if (option === undefined) return FAIL;
        if (!ids.includes(option.id)) ids.push(option.id);
      }
      return done(ids);
    }
    case "date": {
      if (trimmed === "") return done(null);
      const [start, end] = trimmed.split(/\s*(?:→|->)\s*/);
      const startDate = parseTypedDay(start ?? "");
      const endDate = end === undefined ? "" : parseTypedDay(end);
      if (startDate === null || endDate === null) return FAIL;
      const value = buildDateValue(
        { ...EMPTY_DATE_DRAFT, startDate, endDate, hasEnd: endDate !== "" },
        "UTC",
      );
      return done(value);
    }
    default:
      return FAIL;
  }
}
