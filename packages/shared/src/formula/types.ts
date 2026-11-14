export const FORMULA_VERSION = 1;

export type FormulaType =
  | "number"
  | "text"
  | "boolean"
  | "date"
  | "any"
  | "empty"
  | { readonly list: FormulaType }
  | { readonly page: string; readonly far?: true };

export type FormulaErrorCode =
  | "syntax"
  | "unknown_function"
  | "unknown_property"
  | "unknown_variable"
  | "arity"
  | "type"
  | "limit"
  | "unsupported";

export interface FormulaDiagnostic {
  readonly code: FormulaErrorCode;
  readonly message: string;
  readonly start: number;
  readonly end: number;
}

export interface FormulaProperty {
  readonly id: string;
  readonly name: string;
  readonly type: FormulaType;
  readonly relationTo?: string;
  readonly volatile?: boolean;
  readonly broken?: boolean;
  readonly deleted?: boolean;
}

export interface FormulaSchema {
  readonly dataSourceId: string;
  readonly properties: ReadonlyArray<FormulaProperty>;
  source(dataSourceId: string): ReadonlyArray<FormulaProperty> | undefined;
  /** Display name for messages; optional. */
  databaseName?(dataSourceId: string): string | undefined;
}

export interface FormulaRef {
  readonly start: number;
  readonly end: number;
  readonly dataSourceId: string;
  readonly propertyId: string;
}

export interface FormulaDeps {
  readonly own: ReadonlyArray<string>;
  readonly related: ReadonlyArray<{
    readonly relationPropertyId: string;
    readonly dataSourceId: string;
    readonly propertyIds: ReadonlyArray<string>;
  }>;
}

export const isListType = (t: FormulaType): t is { readonly list: FormulaType } =>
  typeof t === "object" && "list" in t;
export const isPageType = (t: FormulaType): t is { readonly page: string; readonly far?: true } =>
  typeof t === "object" && "page" in t;

export function typeLabel(type: FormulaType): string {
  if (typeof type === "string") return type;
  if (isListType(type)) return `list of ${typeLabel(type.list)}`;
  return "page";
}

/** The common type of two types, or undefined when they cannot be mixed. */
export function unify(a: FormulaType, b: FormulaType): FormulaType | undefined {
  if (a === "any" || b === "any") return "any";
  if (a === "empty") return b;
  if (b === "empty") return a;
  if (typeof a === "string" || typeof b === "string") return a === b ? a : undefined;
  if (isListType(a) && isListType(b)) {
    const inner = unify(a.list, b.list);
    return inner === undefined ? undefined : { list: inner };
  }
  if (isPageType(a) && isPageType(b)) {
    if (a.page !== b.page) return undefined;
    return a.far || b.far ? { page: a.page, far: true } : a;
  }
  return undefined;
}

export function containsFarPage(t: FormulaType): boolean {
  if (isListType(t)) return containsFarPage(t.list);
  return isPageType(t) && t.far === true;
}

export function farify(t: FormulaType): FormulaType {
  if (isListType(t)) return { list: farify(t.list) };
  if (isPageType(t)) return { page: t.page, far: true };
  return t;
}

/** Element type when `t` is a list, `any` when unknown, undefined for non-lists. */
export function elementType(t: FormulaType): FormulaType | undefined {
  if (isListType(t)) return t.list;
  return t === "any" || t === "empty" ? "any" : undefined;
}
