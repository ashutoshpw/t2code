import {
  type DateValue,
  type FormulaType,
  type FormulaValue,
  type RichText,
  type Run,
  formatValue,
} from "@t2code/shared/formula";

import { byteLength, canonical, databaseLimits } from "../../CorePolicy.ts";
import { parseDateValue } from "../CellDate.ts";
import { type CellItem, type CellRow, emptyItem, numberItem, textItem } from "../CellCodec.ts";
import { truncateBytes } from "../Fold.ts";
import { type Json, type JsonObject, isObject, parseJson } from "../Json.ts";
import type { Property } from "../SchemaStore.ts";
import { isoNow } from "../Types.ts";

const isRich = (value: FormulaValue): value is RichText =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value as { kind?: string }).kind === "rich";
const isDate = (value: FormulaValue): value is DateValue =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value as { kind?: string }).kind === "date";
const isList = (value: FormulaValue): value is ReadonlyArray<FormulaValue> => Array.isArray(value);
const isPage = (value: FormulaValue): value is { kind: "page"; id: string; ds: string } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value as { kind?: string }).kind === "page";

export interface PageFields {
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly row_seq: number | null;
}

/** Computed values hold at most this many list items in total. */
const MAX_ITEMS = 100;
const PLAIN_MARKS = ["bold", "italic", "underline", "strike", "code"] as const;

const dayText = (ms: number) => isoNow(ms).slice(0, 10);
const instantText = (ms: number) => isoNow(ms);

const dateWire = (value: DateValue): JsonObject => {
  const text = value.timed ? instantText : dayText;
  return {
    start: text(value.start),
    ...(value.end === undefined ? {} : { end: text(value.end) }),
    ...(value.zone === undefined ? {} : { timeZone: value.zone }),
  };
};

const runWire = (run: Run): Json => {
  const marks: Json[] = [];
  for (const mark of PLAIN_MARKS) if (run[mark] === true) marks.push({ type: mark, version: 1 });
  if (run.color !== undefined) marks.push({ type: "color", version: 1, value: run.color });
  if (run.background !== undefined)
    marks.push({ type: "highlight", version: 1, value: run.background });
  if (run.link !== undefined) marks.push({ type: "link", version: 1, href: run.link });
  return { text: run.text, marks };
};

interface WireContext {
  /** Option colors by name, for rollups that show select values. */
  readonly colorOf?: (name: string) => string | undefined;
}

interface Budget {
  left: number;
  truncated: boolean;
}

const wireOf = (value: FormulaValue, ctx: WireContext, budget: Budget): JsonObject | undefined => {
  if (value === null) return undefined;
  if (typeof value === "number") return { type: "number", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "string") {
    const color = ctx.colorOf?.(value);
    return { type: "string", value, ...(color === undefined ? {} : { color }) };
  }
  if (isRich(value))
    return {
      type: "string",
      value: value.runs.map((run) => run.text).join(""),
      runs: value.runs.map(runWire),
    };
  if (isDate(value)) return { type: "date", value: dateWire(value) };
  if (isPage(value)) return { type: "page", value: value.id, dataSourceId: value.ds };
  if (!isList(value)) return undefined;
  const items: Json[] = [];
  let truncated = false;
  for (const item of value) {
    if (budget.left <= 0) {
      truncated = true;
      break;
    }
    budget.left -= 1;
    const wire = wireOf(item, ctx, budget);
    if (wire !== undefined) items.push(wire);
  }
  if (truncated) budget.truncated = true;
  return { type: "array", value: items, ...(truncated ? { truncated: true } : {}) };
};

/** Cuts a wire value until its canonical JSON fits one cell. */
const fit = (wire: JsonObject): JsonObject => {
  const max = databaseLimits.maxCellTextBytes;
  let current = wire;
  while (byteLength(current) > max) {
    if (current.type === "array" && Array.isArray(current.value) && current.value.length > 0) {
      const keep = Math.floor(current.value.length / 2);
      current = Object.assign({}, current, {
        value: current.value.slice(0, keep),
        truncated: true,
      });
    } else if (current.type === "string" && typeof current.value === "string") {
      const { runs: _dropped, ...rest } = current;
      current = { ...rest, value: truncateBytes(current.value, Math.floor(max / 2)) };
    } else return { type: "string", value: "" };
  }
  return current;
};

/** The wire `SpaceComputedValue` of a value; undefined for an empty one. */
export const valueToWire = (value: FormulaValue, ctx: WireContext = {}) => {
  const wire = wireOf(value, ctx, { left: MAX_ITEMS, truncated: false });
  return wire === undefined ? undefined : fit(wire);
};

const marksToRun = (text: string, marks: unknown): Run => {
  const run: { -readonly [K in keyof Run]: Run[K] } = { text };
  if (!Array.isArray(marks)) return run;
  for (const mark of marks) {
    if (!isObject(mark)) continue;
    if (PLAIN_MARKS.some((name) => name === mark.type))
      Object.assign(run, { [String(mark.type)]: true });
    else if (mark.type === "color" && typeof mark.value === "string") run.color = mark.value;
    else if (mark.type === "highlight" && typeof mark.value === "string")
      run.background = mark.value;
    else if (mark.type === "link" && typeof mark.href === "string") run.link = mark.href;
  }
  return run;
};

const dateFromWire = (value: unknown): FormulaValue => {
  if (!isObject(value) || typeof value.start !== "string") return null;
  const parsed = parseDateValue({
    start: value.start,
    ...(typeof value.end === "string" ? { end: value.end } : {}),
    ...(typeof value.timeZone === "string" ? { timeZone: value.timeZone } : {}),
  });
  if (parsed === undefined) return null;
  return {
    kind: "date",
    start: parsed.timeStart,
    ...(parsed.timeEnd === null ? {} : { end: parsed.timeEnd }),
    timed: parsed.hasTime,
    ...(typeof value.timeZone === "string" ? { zone: value.timeZone } : {}),
  };
};

/** The inverse of `valueToWire`, for reading a stored computed value back into a formula. */
const wireToValue = (wire: Json | undefined): FormulaValue => {
  if (!isObject(wire)) return null;
  switch (wire.type) {
    case "number":
      return typeof wire.value === "number" ? wire.value : null;
    case "boolean":
      return typeof wire.value === "boolean" ? wire.value : null;
    case "string": {
      if (typeof wire.value !== "string") return null;
      if (!Array.isArray(wire.runs)) return wire.value;
      return {
        kind: "rich",
        runs: wire.runs.flatMap((run) =>
          isObject(run) && typeof run.text === "string" ? [marksToRun(run.text, run.marks)] : [],
        ),
      };
    }
    case "date":
      return dateFromWire(wire.value);
    case "page":
      return typeof wire.value === "string"
        ? {
            kind: "page",
            id: wire.value,
            ds: typeof wire.dataSourceId === "string" ? wire.dataSourceId : "",
          }
        : null;
    case "array":
      return Array.isArray(wire.value) ? wire.value.map((item) => wireToValue(item)) : null;
    default:
      return null;
  }
};

/** Page ids named by a computed wire value, for the related-pages lookup. */
export const wirePageIds = (wire: Json | undefined, into: Set<string>) => {
  if (!isObject(wire)) return;
  if (wire.type === "page" && typeof wire.value === "string") into.add(wire.value);
  else if (wire.type === "array" && Array.isArray(wire.value))
    for (const item of wire.value) wirePageIds(item, into);
};

interface EncodeContext extends WireContext {
  readonly timeZone: string;
  titleOf(pageId: string): string | undefined;
}

const NONE: readonly CellItem[] = [];

/**
 * The cell rows of one computed value (section 2.2): typed columns for the query layer plus the
 * wire JSON in `value`. Empty values (null, "", [], false) have no rows.
 */
export const toCellItems = (
  value: FormulaValue,
  resultType: FormulaType,
  ctx: EncodeContext,
): readonly CellItem[] => {
  let next = value;
  if (resultType === "text" && next !== null && typeof next !== "string" && !isRich(next))
    next = formatValue(next, ctx);
  if (next === null || next === "" || next === false) return NONE;
  const wire = valueToWire(next, ctx);
  if (wire === undefined) return NONE;
  const json = canonical(wire);
  if (typeof next === "number") return [{ ...numberItem(next), value: json }];
  if (next === true) return [{ ...numberItem(1), value: json }];
  if (isDate(next))
    return [
      {
        ...emptyItem,
        time_start: next.start,
        time_end: next.end ?? null,
        flags: next.timed ? 1 : 0,
        value: json,
      },
    ];
  if (typeof next === "string" || isRich(next)) {
    // The cut text, so the columns never hold more than the wire value does.
    const plain = typeof wire.value === "string" ? wire.value : "";
    return plain === "" ? NONE : [{ ...textItem(plain), value: json }];
  }
  if (isPage(next)) {
    const title = ctx.titleOf(next.id);
    return [{ ...textItem(title === undefined || title === "" ? "Untitled" : title), value: json }];
  }
  const text = formatValue(next, ctx);
  return text === "" ? NONE : [{ ...textItem(text), value: json }];
};

const jsonOf = (row: CellRow | undefined) =>
  row === undefined || row.value === null ? undefined : parseJson(row.value);

const optionNames = (property: Property, rows: readonly CellRow[]) =>
  rows.flatMap((row) => {
    const option = property.options.find((candidate) => candidate.option_id === row.ref);
    return option === undefined ? [] : [option.name];
  });

/** The formula value of a stored (non-relation) property, per the table in plan 1.4. */
export const readStored = (
  property: Property,
  rows: readonly CellRow[],
  page: PageFields,
): FormulaValue => {
  const first = rows[0];
  switch (property.type) {
    case "title":
      return page.title === "" ? null : page.title;
    case "text": {
      const runs = jsonOf(first);
      const text = Array.isArray(runs)
        ? runs
            .map((run) => (isObject(run) && typeof run.text === "string" ? run.text : ""))
            .join("")
        : "";
      return text === "" ? null : text;
    }
    case "url":
    case "email":
    case "phone": {
      const text = jsonOf(first);
      return typeof text === "string" && text !== "" ? text : null;
    }
    case "number":
      return first?.num ?? null;
    case "checkbox":
      return first?.num === 1;
    case "select":
    case "status":
      return optionNames(property, rows)[0] ?? null;
    case "multi_select":
      return optionNames(property, rows);
    case "date": {
      if (first?.time_start == null) return null;
      const zone = jsonOf(first);
      return {
        kind: "date",
        start: first.time_start,
        ...(first.time_end === null ? {} : { end: first.time_end }),
        timed: (first.flags & 1) === 1,
        ...(isObject(zone) && typeof zone.timeZone === "string" ? { zone: zone.timeZone } : {}),
      };
    }
    case "created_time":
    case "last_edited_time": {
      const ms = Date.parse(property.type === "created_time" ? page.created_at : page.updated_at);
      return Number.isFinite(ms) ? { kind: "date", start: ms, timed: true } : null;
    }
    case "unique_id": {
      const prefix = property.config.prefix;
      const number = page.row_seq ?? 0;
      return typeof prefix === "string" && prefix !== "" ? `${prefix}-${number}` : String(number);
    }
    case "files":
      return rows.flatMap((row) => {
        const file = jsonOf(row);
        if (!isObject(file)) return [];
        const name = typeof file.url === "string" ? file.url : file.name;
        return typeof name === "string" ? [name] : [];
      });
    case "formula":
    case "rollup":
      return wireToValue(jsonOf(first));
    default:
      return null;
  }
};
