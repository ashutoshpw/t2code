import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

import { byteLength, canonical, databaseLimits } from "../CorePolicy.ts";
import * as SpacesSql from "../SpacesSql.ts";
import { parseDateValue } from "./CellDate.ts";
import * as CellCodec from "./CellCodec.ts";
import {
  type CellItem,
  type CellRow,
  emptyItem,
  numberItem,
  refItem,
  textItem,
} from "./CellCodec.ts";
import { fold } from "./Fold.ts";
import { type Json, isObject, parseJson } from "./Json.ts";
import type { Property } from "./SchemaStore.ts";
import type { OptionRecord } from "./Types.ts";

const numberPattern = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const truthy = new Set(["yes", "true", "1", "checked"]);
const optionTypes = new Set<C.SpacePropertyType>(["select", "multi_select", "status"]);

/** `clear` counts as a cell that could not be converted; an empty list is a valid empty value. */
type Converted = readonly CellItem[] | "clear";

const plainOf = (type: C.SpacePropertyType, rows: readonly CellRow[]): string => {
  const first = rows[0];
  if (!first) return "";
  const value = first.value === null ? null : parseJson(first.value);
  if (type === "text" && Array.isArray(value))
    return CellCodec.plainRuns(
      value.filter(isObject).map((run) => ({ text: String(run.text ?? "") })),
    );
  return typeof value === "string" ? value : "";
};

/** Adds an option and returns its id, or undefined when the property is full. */
type CreateOption = (
  name: string,
) => Effect.Effect<string | undefined, C.SpaceServiceError | SqlError, SpacesSql.SpacesSql>;

/** Builds the stored items for `to` from plain text, per the conversion matrix. */
const fromText = Effect.fn("SpacesDatabases.convertFromText")(function* (
  to: C.SpacePropertyType,
  text: string,
  state: { find: (name: string) => string | undefined; create: CreateOption },
) {
  const trimmed = text.trim();
  if (to === "text") return text === "" ? [] : [textItem(text, [{ text, marks: [] }])];
  if (to === "url" || to === "email" || to === "phone")
    return trimmed === "" ? [] : [textItem(trimmed, trimmed)];
  if (to === "number") {
    if (trimmed === "") return [];
    const cleaned = trimmed.replaceAll(",", "");
    const n = numberPattern.test(cleaned) ? Number(cleaned) : Number.NaN;
    return Number.isFinite(n) ? [numberItem(n)] : ("clear" as const);
  }
  if (to === "checkbox") return truthy.has(fold(trimmed)) ? [numberItem(1)] : [];
  if (to === "date") {
    if (trimmed === "") return [];
    const parsed = parseDateValue({ start: trimmed });
    return parsed
      ? [
          {
            ...emptyItem,
            time_start: parsed.timeStart,
            time_end: null,
            flags: parsed.hasTime ? 1 : 0,
            value: canonical({ start: trimmed }),
          },
        ]
      : ("clear" as const);
  }
  if (to === "select" || to === "status") {
    if (trimmed === "") return [];
    const id = state.find(trimmed) ?? (to === "select" ? yield* state.create(trimmed) : undefined);
    return id === undefined ? ("clear" as const) : [refItem(id)];
  }
  if (to === "multi_select") {
    const names = [
      ...new Set(
        trimmed
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      ),
    ].slice(0, databaseLimits.maxCellItems);
    const ids: string[] = [];
    for (const name of names) {
      const id = state.find(name) ?? (yield* state.create(name));
      if (id !== undefined && !ids.includes(id)) ids.push(id);
    }
    return ids.length === 0 && names.length > 0 ? ("clear" as const) : ids.map(refItem);
  }
  return "clear" as const;
});

interface ConvertInput {
  readonly from: Property;
  readonly to: C.SpacePropertyType;
  /** Options of the converted property, including any added while converting. */
  readonly options: readonly OptionRecord[];
  readonly createOption: CreateOption;
}

const sameFamily = (a: C.SpacePropertyType, b: C.SpacePropertyType) =>
  CellCodec.textLike.has(a) && CellCodec.textLike.has(b);

/** One cell's conversion; the caller deletes the old rows and stores the result. */
export const convertCell = Effect.fn("SpacesDatabases.convertCell")(function* (
  input: ConvertInput,
  rows: readonly CellRow[],
) {
  const { from, to } = input;
  const state = {
    find: (name: string) =>
      input.options.find((option) => option.name_key === fold(name))?.option_id,
    create: input.createOption,
  };
  const bytes = (items: readonly CellItem[]): Converted =>
    items.some(
      (item) => item.value !== null && byteLength(item.value) > databaseLimits.maxCellTextBytes,
    )
      ? "clear"
      : items;
  let result: Converted;
  if (CellCodec.textLike.has(from.type)) {
    const text = plainOf(from.type, rows);
    result =
      sameFamily(from.type, to) ||
      to === "number" ||
      to === "select" ||
      to === "multi_select" ||
      to === "status" ||
      to === "checkbox" ||
      to === "date"
        ? yield* fromText(to, text, state)
        : "clear";
  } else if (from.type === "number") {
    const n = rows[0]?.num ?? 0;
    if (CellCodec.textLike.has(to) || to === "select" || to === "multi_select" || to === "status")
      result = yield* fromText(to, String(n), state);
    else result = to === "checkbox" ? (n !== 0 ? [numberItem(1)] : []) : "clear";
  } else if (optionTypes.has(from.type)) {
    const refs = rows.flatMap((row) => (row.ref === null ? [] : [row.ref]));
    if (to === "multi_select") result = refs.map(refItem);
    else if (to === "select" || to === "status")
      result = refs.length === 0 ? [] : [refItem(refs[0]!)];
    else {
      const names = refs.map(
        (id) => from.options.find((option) => option.option_id === id)?.name ?? "",
      );
      const joined = names.filter(Boolean).join(", ");
      result =
        CellCodec.textLike.has(to) || to === "number"
          ? yield* fromText(to, joined, state)
          : "clear";
    }
  } else if (from.type === "checkbox") {
    result =
      to === "number"
        ? [numberItem(1)]
        : CellCodec.textLike.has(to)
          ? yield* fromText(to, "Yes", state)
          : "clear";
  } else if (from.type === "date") {
    const value: Json | null = rows[0]?.value ? parseJson(rows[0].value) : null;
    const text =
      isObject(value) && typeof value.start === "string"
        ? typeof value.end === "string"
          ? `${value.start} → ${value.end}`
          : value.start
        : "";
    result = CellCodec.textLike.has(to) ? yield* fromText(to, text, state) : "clear";
  } else result = "clear";
  return result === "clear" ? result : bytes(result);
});
