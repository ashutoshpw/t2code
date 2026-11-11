import type * as C from "@t2code/contracts/spaces";
import {
  FORMULA_VERSION,
  type BoundNode,
  type FormulaDeps,
  type FormulaRef,
  type FormulaType,
} from "@t2code/shared/formula";

import { isObject, parseJson } from "../Json.ts";

/** The server-owned definition of a formula or rollup, stored as JSON in `spaces_db_properties.computed`. */
export interface ComputedRecord {
  readonly v: number;
  readonly kind: "formula" | "rollup";
  /** Formulas: the compiled tree over property ids. Absent when the source never compiled. */
  readonly ast?: BoundNode;
  readonly refs?: ReadonlyArray<FormulaRef>;
  readonly type: FormulaType;
  /** Rollups: the formula type of the rolled-up property. */
  readonly targetType?: FormulaType;
  readonly deps: FormulaDeps;
  readonly volatile: boolean;
  readonly error?: string;
}

const cache = new Map<string, ComputedRecord | null>();

const isDeps = (value: unknown): value is FormulaDeps =>
  isObject(value) && Array.isArray(value.own) && Array.isArray(value.related);

const read = (json: string): ComputedRecord | null => {
  try {
    const value = parseJson(json);
    if (
      !isObject(value) ||
      (value.kind !== "formula" && value.kind !== "rollup") ||
      typeof value.v !== "number" ||
      value.type === undefined ||
      !isDeps(value.deps)
    )
      return null;
    return {
      v: value.v,
      kind: value.kind,
      ...(isObject(value.ast) ? { ast: value.ast as BoundNode } : {}),
      ...(Array.isArray(value.refs) ? { refs: value.refs as FormulaRef[] } : {}),
      type: value.type as FormulaType,
      ...(value.targetType === undefined ? {} : { targetType: value.targetType as FormulaType }),
      deps: value.deps as FormulaDeps,
      volatile: value.volatile === true,
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    };
  } catch {
    return null;
  }
};

/** Parsed once per distinct JSON string; a malformed record counts as never compiled. */
export const parseRecord = (json: string | null): ComputedRecord | null => {
  if (json === null) return null;
  const hit = cache.get(json);
  if (hit !== undefined) return hit;
  const record = read(json);
  if (cache.size >= 500) cache.clear();
  cache.set(json, record);
  return record;
};

export const serializeRecord = (record: ComputedRecord) => JSON.stringify(record);

export const currentVersion = (record: ComputedRecord | null) =>
  record !== null && record.v === FORMULA_VERSION;

/** A stored value exists for it: compiled, no error, and not reading the clock. */
export const isMaterialized = (record: ComputedRecord | null): record is ComputedRecord =>
  record !== null && record.error === undefined && !record.volatile;

/** The stored type a computed property filters, sorts, groups and aggregates as. */
export const queryTypeOf = (record: ComputedRecord | null): C.SpacePropertyType | undefined => {
  if (!isMaterialized(record)) return undefined;
  switch (record.type) {
    case "number":
      return "number";
    case "boolean":
      return "checkbox";
    case "date":
      return "date";
    default:
      return "text";
  }
};

export const emptyDeps: FormulaDeps = { own: [], related: [] };
