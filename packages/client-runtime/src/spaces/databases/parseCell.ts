import type { SpaceCellValue, SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";

import { buildDateValue, parseTypedDay, EMPTY_DATE_DRAFT } from "./dateValue.ts";

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

/**
 * A typed number under a locale whose decimal separator is `decimal` ("," or anything else as "."),
 * the other of the two being its group separator. Spaces and apostrophes are ignored; a group
 * separator must sit between a 1-3 digit head and 3-digit groups, the decimal separator may appear
 * once. Input that breaks this ("1,2,3", "1.5" under a comma locale) is `undefined`, never guessed.
 */
export function parseLocalizedNumber(
  text: string,
  format: string,
  decimal: string,
): number | null | undefined {
  const dec = decimal === "," ? "," : ".";
  const group = dec === "," ? "." : ",";
  let value = text.trim().replace(/[\s_'\u2019]/gu, "");
  if (value === "") return null;
  if (value.endsWith("%")) value = value.slice(0, -1);
  value = value.replace(/^([+-]?)\p{Sc}+/u, "$1");
  const g = `\\${group}`;
  const d = `\\${dec}`;
  const shape = new RegExp(
    `^([+-]?)(\\d{1,3}(?:${g}\\d{3})+|\\d*)(?:${d}(\\d*))?(e[+-]?\\d+)?$`,
    "i",
  ).exec(value);
  if (shape === null) return undefined;
  const [, sign = "", whole = "", fraction = "", exponent = ""] = shape;
  const digits = whole.split(group).join("");
  if (digits === "" && fraction === "") return undefined;
  const number = Number(
    `${sign}${digits || "0"}${fraction === "" ? "" : `.${fraction}`}${exponent}`,
  );
  if (!Number.isFinite(number)) return undefined;
  return format === "percent" ? Number((number / 100).toPrecision(12)) : number;
}

/** The number as typed in an editor: percent values are shown as whole percents. */
export function numberToText(value: number, format: string, decimal = "."): string {
  const text = String(format === "percent" ? Number((value * 100).toPrecision(12)) : value);
  return decimal === "," ? text.replace(".", ",") : text;
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

/** The decimal separator of a locale tag; "." when the runtime cannot tell. */
export function localeDecimal(locale?: string): string {
  try {
    const part = new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === "decimal");
    return part?.value ?? ".";
  } catch {
    return ".";
  }
}

/**
 * Plain text (a pasted cell or a typed value) to the cell it stands for; never a partial value.
 * Under a comma-decimal locale (`decimal: ","`) numbers read strictly by that locale; otherwise a
 * comma is a grouping mark, so "1,5" is 15.
 */
export function parseCell(
  text: string,
  known: SpaceKnownDatabaseProperty,
  locale?: { readonly decimal: string },
): ParsedCell {
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
      const number =
        locale?.decimal === ","
          ? parseLocalizedNumber(text, known.config.format, ",")
          : parseNumber(text, known.config.format);
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
