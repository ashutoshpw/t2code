import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { byteLength, canonical, ensureDatabaseLimit, ensureLimit } from "../CorePolicy.ts";
import { parseDateValue } from "./CellDate.ts";
import { textKeys } from "./Fold.ts";
import { type Json, isObject, parseJson } from "./Json.ts";
import type { Property } from "./SchemaStore.ts";
import { dbError } from "./Types.ts";

/** One stored cell row without its key columns. */
export interface CellItem {
  readonly ref: string | null;
  readonly text_key: string | null;
  readonly text_full: string | null;
  readonly num: number | null;
  readonly time_start: number | null;
  readonly time_end: number | null;
  readonly flags: number;
  readonly value: string | null;
}
export interface CellRow extends CellItem {
  readonly page_id: string;
  readonly property_id: string;
  readonly ord: number;
  readonly data_source_id: string;
}

export const emptyItem: CellItem = {
  ref: null,
  text_key: null,
  text_full: null,
  num: null,
  time_start: null,
  time_end: null,
  flags: 0,
  value: null,
};

export const textItem = (text: string, value: Json | null = null): CellItem => {
  const keys = textKeys(text);
  return {
    ...emptyItem,
    text_key: keys.key,
    text_full: keys.full,
    value: value === null ? null : canonical(value),
  };
};
export const refItem = (ref: string): CellItem => ({ ...emptyItem, ref });
export const numberItem = (num: number): CellItem => ({ ...emptyItem, num });

/** Types whose writes a client may not make. */
export const readOnlyTypes = new Set<C.SpacePropertyType>([
  "created_time",
  "last_edited_time",
  "unique_id",
  "formula",
  "rollup",
]);
export const textLike = new Set<C.SpacePropertyType>(["text", "url", "email", "phone"]);

const decoders = {
  text: Schema.decodeUnknownOption(C.SpaceKnownCellValue.text, { onExcessProperty: "error" }),
  number: Schema.decodeUnknownOption(C.SpaceKnownCellValue.number),
  string: Schema.decodeUnknownOption(Schema.String),
  boolean: Schema.decodeUnknownOption(Schema.Boolean),
  ids: Schema.decodeUnknownOption(Schema.Array(Schema.String)),
  date: Schema.decodeUnknownOption(C.SpaceKnownCellValue.date, { onExcessProperty: "error" }),
  files: Schema.decodeUnknownOption(C.SpaceKnownCellValue.files, { onExcessProperty: "error" }),
};
const unwrap = Option.getOrUndefined;

export const plainRuns = (runs: readonly { readonly text: string }[]) =>
  runs.map((run) => run.text).join("");

const distinct = (ids: readonly string[]) => new Set(ids).size === ids.length;

/** Validates a wire value for a stored property and returns its cell rows; [] clears the cell. */
export const encode = Effect.fn("SpacesDatabases.encodeCell")(function* (
  property: Property,
  wire: Json,
) {
  const invalid = () => dbError("invalid_value", property.id);
  const bytes = (value: unknown) => ensureDatabaseLimit("maxCellTextBytes", byteLength(value));
  switch (property.type) {
    case "title": {
      const text = unwrap(decoders.string(wire));
      if (text === undefined) return yield* invalid();
      yield* ensureLimit("maxTitleBytes", byteLength(text));
      return text === "" ? [] : [textItem(text)];
    }
    case "text": {
      const runs = unwrap(decoders.text(wire));
      if (runs === undefined) return yield* invalid();
      yield* bytes(runs);
      const text = plainRuns(runs);
      return text === "" ? [] : [textItem(text, runs)];
    }
    case "url":
    case "email":
    case "phone": {
      const text = unwrap(decoders.string(wire))?.trim();
      if (text === undefined) return yield* invalid();
      yield* bytes(text);
      return text === "" ? [] : [textItem(text, text)];
    }
    case "number": {
      const num = unwrap(decoders.number(wire));
      return num === undefined ? yield* invalid() : [numberItem(num)];
    }
    case "checkbox": {
      const checked = unwrap(decoders.boolean(wire));
      return checked === undefined ? yield* invalid() : checked ? [numberItem(1)] : [];
    }
    case "select":
    case "status": {
      const id = unwrap(decoders.string(wire));
      if (id === undefined) return yield* invalid();
      if (!property.options.some((option) => option.option_id === id))
        return yield* dbError("unknown_option", property.id);
      return [refItem(id)];
    }
    case "multi_select": {
      const ids = unwrap(decoders.ids(wire));
      if (ids === undefined || !distinct(ids)) return yield* invalid();
      yield* ensureDatabaseLimit("maxCellItems", ids.length);
      for (const id of ids)
        if (!property.options.some((option) => option.option_id === id))
          return yield* dbError("unknown_option", property.id);
      return ids.map(refItem);
    }
    case "date": {
      const value = unwrap(decoders.date(wire));
      const parsed = value && parseDateValue(value);
      if (!value || !parsed) return yield* invalid();
      return [
        {
          ...emptyItem,
          time_start: parsed.timeStart,
          time_end: parsed.timeEnd,
          flags: parsed.hasTime ? 1 : 0,
          value: canonical(value),
        },
      ];
    }
    case "files": {
      const files = unwrap(decoders.files(wire));
      if (files === undefined) return yield* invalid();
      yield* ensureDatabaseLimit("maxCellItems", files.length);
      const items: CellItem[] = [];
      for (const file of files) {
        if ("assetId" in file) return yield* dbError("unsupported", property.id);
        const url = URL.canParse(file.url) ? new URL(file.url) : undefined;
        if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
          return yield* invalid();
        yield* bytes(file);
        items.push(textItem(file.name, file));
      }
      return items;
    }
    case "relation": {
      const ids = unwrap(decoders.ids(wire));
      if (ids === undefined || !distinct(ids)) return yield* invalid();
      yield* ensureDatabaseLimit("maxCellItems", ids.length);
      return ids.map(refItem);
    }
    default:
      return yield* dbError("read_only_property", property.id);
  }
});

const parseValue = (rows: readonly CellItem[]) =>
  rows.map((row) => (row.value === null ? null : parseJson(row.value)));

/** The wire value of a stored property; undefined when the cell is empty. */
export function decode(property: Property, rows: readonly CellItem[]): Json | undefined {
  if (rows.length === 0) return undefined;
  const first = rows[0]!;
  switch (property.type) {
    case "text":
    case "url":
    case "email":
    case "phone":
    case "date":
      return parseValue([first])[0] ?? undefined;
    case "number":
      return first.num ?? undefined;
    case "checkbox":
      return first.num === 1 ? true : undefined;
    case "select":
    case "status":
      return first.ref ?? undefined;
    case "multi_select":
    case "relation":
      return rows.flatMap((row) => (row.ref === null ? [] : [row.ref]));
    case "files":
      return parseValue(rows).filter(isObject);
    default:
      return undefined;
  }
}
