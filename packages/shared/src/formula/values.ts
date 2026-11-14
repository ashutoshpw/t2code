import { fieldsAt, fieldsOfWallMs, formatFields, normalizeZone, wallToInstant } from "./dates.ts";

export interface Run {
  readonly text: string;
  readonly bold?: true;
  readonly italic?: true;
  readonly underline?: true;
  readonly strike?: true;
  readonly code?: true;
  readonly color?: string;
  readonly background?: string;
  readonly link?: string;
}
export interface RichText {
  readonly kind: "rich";
  readonly runs: ReadonlyArray<Run>;
}
export interface DateValue {
  readonly kind: "date";
  readonly start: number;
  readonly end?: number;
  readonly timed: boolean;
  readonly zone?: string;
}
export interface PageValue {
  readonly kind: "page";
  readonly id: string;
  readonly ds: string;
}
export type FormulaValue =
  | null
  | number
  | boolean
  | string
  | RichText
  | DateValue
  | PageValue
  | ReadonlyArray<FormulaValue>;

export const MAX_LIST = 1000;
export const MAX_TEXT = 16_384;

export const isRich = (v: FormulaValue): v is RichText =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  (v as { kind?: string }).kind === "rich";
export const isDateValue = (v: FormulaValue): v is DateValue =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  (v as { kind?: string }).kind === "date";
export const isPageValue = (v: FormulaValue): v is PageValue =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  (v as { kind?: string }).kind === "page";
export const isListValue = (v: FormulaValue): v is ReadonlyArray<FormulaValue> => Array.isArray(v);

/** A finite number or null. */
export const num = (n: number): number | null => (Number.isFinite(n) ? (n === 0 ? 0 : n) : null);

export function capText(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  const cut = text.charCodeAt(MAX_TEXT - 1);
  return text.slice(0, cut >= 0xd800 && cut <= 0xdbff ? MAX_TEXT - 1 : MAX_TEXT);
}

export const capList = <T>(items: ReadonlyArray<T>): ReadonlyArray<T> =>
  items.length > MAX_LIST ? items.slice(0, MAX_LIST) : items;

export function plainText(v: FormulaValue): string | null {
  if (typeof v === "string") return v;
  if (isRich(v)) return v.runs.map((r) => r.text).join("");
  return null;
}

const isStyled = (r: Run): boolean =>
  r.bold === true ||
  r.italic === true ||
  r.underline === true ||
  r.strike === true ||
  r.code === true ||
  r.color !== undefined ||
  r.background !== undefined ||
  r.link !== undefined;

const sameStyle = (a: Run, b: Run): boolean =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.strike === b.strike &&
  a.code === b.code &&
  a.color === b.color &&
  a.background === b.background &&
  a.link === b.link;

export const runsOf = (v: string | RichText): ReadonlyArray<Run> =>
  typeof v === "string" ? (v === "" ? [] : [{ text: v }]) : v.runs;

/** Plain string when no run is styled, otherwise rich text with adjacent equal runs merged. */
export function richOrPlain(runs: ReadonlyArray<Run>): string | RichText {
  const merged: Run[] = [];
  for (const run of runs) {
    if (run.text === "") continue;
    const last = merged[merged.length - 1];
    if (last !== undefined && sameStyle(last, run) && last.link === undefined) {
      merged[merged.length - 1] = { ...last, text: last.text + run.text };
    } else merged.push(run);
  }
  if (!merged.some(isStyled)) return capText(merged.map((r) => r.text).join(""));
  return { kind: "rich", runs: merged };
}

export function joinText(a: string | RichText, b: string | RichText): string | RichText {
  if (typeof a === "string" && typeof b === "string") return capText(a + b);
  return richOrPlain([...runsOf(a), ...runsOf(b)]);
}

export function isEmptyValue(v: FormulaValue): boolean {
  if (v === null || v === false || v === 0 || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isRich(v)) return v.runs.every((r) => r.text === "");
  return false;
}

export const effectiveEnd = (d: DateValue): number => d.end ?? d.start;

/** Instant of an end of a date value; a date-only side is its midnight in the zone. */
export function instantOf(d: DateValue, value: number, timeZone: string): number {
  return d.timed ? value : wallToInstant(value, normalizeZone(d.zone ?? timeZone));
}

function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) ?? 0;
    const cb = b.codePointAt(j) ?? 0;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}

/** Charges the evaluation budget; the walkers below pass the runtime's `tick`. */
export type Tick = (steps?: number) => void;

export function valuesEqual(
  a: FormulaValue,
  b: FormulaValue,
  timeZone: string,
  tick?: Tick,
): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "number" || typeof a === "boolean") return a === b;
  const ta = plainText(a);
  if (ta !== null) return plainText(b) === ta;
  if (isDateValue(a)) {
    if (!isDateValue(b)) return false;
    if (!a.timed && !b.timed) return a.start === b.start && effectiveEnd(a) === effectiveEnd(b);
    return (
      instantOf(a, a.start, timeZone) === instantOf(b, b.start, timeZone) &&
      instantOf(a, effectiveEnd(a), timeZone) === instantOf(b, effectiveEnd(b), timeZone)
    );
  }
  if (isPageValue(a)) return isPageValue(b) && a.id === b.id;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    tick?.(a.length);
    return a.every((item, i) => valuesEqual(item, b[i] ?? null, timeZone, tick));
  }
  return false;
}

const rankOf = (v: FormulaValue): number =>
  typeof v === "number"
    ? 0
    : typeof v === "string" || isRich(v)
      ? 1
      : typeof v === "boolean"
        ? 2
        : isDateValue(v)
          ? 3
          : isPageValue(v)
            ? 4
            : 5;

/** Total order for sorting: null last, kinds number < text < boolean < date < page < list. */
export function compareValues(
  a: FormulaValue,
  b: FormulaValue,
  timeZone: string,
  tick?: Tick,
): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  const ta = plainText(a);
  const tb = plainText(b);
  if (ta !== null && tb !== null) return compareCodePoints(ta, tb);
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  if (isDateValue(a) && isDateValue(b)) {
    const x = instantOf(a, a.start, timeZone);
    const y = instantOf(b, b.start, timeZone);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (isPageValue(a) && isPageValue(b)) return compareCodePoints(a.id, b.id);
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    tick?.(n);
    for (let i = 0; i < n; i += 1) {
      const c = compareValues(a[i] ?? null, b[i] ?? null, timeZone, tick);
      if (c !== 0) return c;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }
  return 0;
}

function formatOneDate(d: DateValue, value: number, timeZone: string): string {
  if (!d.timed) return formatFields(fieldsOfWallMs(value), 0, "MMMM D, YYYY");
  const zone = normalizeZone(d.zone ?? timeZone);
  const f = fieldsAt(value, zone);
  return formatFields(f, 0, "MMMM D, YYYY h:mm A");
}

function formatDateValue(d: DateValue, timeZone: string): string {
  const first = formatOneDate(d, d.start, timeZone);
  return d.end === undefined ? first : `${first} → ${formatOneDate(d, d.end, timeZone)}`;
}

export interface FormatContext {
  readonly timeZone: string;
  titleOf(pageId: string): string | undefined;
  readonly tick?: Tick;
}

export function formatValue(value: FormulaValue, context: FormatContext): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (isRich(value)) return plainText(value) ?? "";
  if (isDateValue(value)) return formatDateValue(value, context.timeZone);
  if (isPageValue(value)) {
    const title = context.titleOf(value.id);
    return title === undefined ? "" : title === "" ? "Untitled" : title;
  }
  context.tick?.(value.length);
  return capText(value.map((item) => formatValue(item, context)).join(", "));
}

/** A string that is equal for exactly the values `valuesEqual` calls equal. */
export function valueKey(v: FormulaValue, timeZone: string, tick?: Tick): string {
  if (v === null) return "z";
  if (typeof v === "number") return `n${v}`;
  if (typeof v === "boolean") return v ? "bt" : "bf";
  const text = plainText(v);
  if (text !== null) return `s${text}`;
  if (isDateValue(v)) {
    return `d${instantOf(v, v.start, timeZone)}:${instantOf(v, effectiveEnd(v), timeZone)}`;
  }
  if (isPageValue(v)) return `p${v.id}`;
  if (isListValue(v)) {
    tick?.(v.length);
    return `[${v.map((item) => JSON.stringify(valueKey(item, timeZone, tick))).join(",")}]`;
  }
  return "z";
}
