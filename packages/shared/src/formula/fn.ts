import type { Runtime } from "./runtime.ts";
import type { FormulaType } from "./types.ts";
import {
  type DateValue,
  type FormulaValue,
  isDateValue,
  isListValue,
  plainText,
} from "./values.ts";

export type ParamKind =
  | "text"
  | "rich"
  | "number"
  | "boolean"
  | "date"
  | "any"
  | "list"
  | "numArg"
  | "unit"
  | "textList"
  | "lambda";

export interface RuleError {
  readonly error: string;
  /** Index of the offending argument; the whole call when absent. */
  readonly arg?: number;
}

export type Lambda = (item: FormulaValue, index: number) => FormulaValue;

export interface FnDef {
  readonly name: string;
  readonly signature: string;
  readonly description: string;
  readonly example: string;
  readonly category: "logic" | "text" | "number" | "date" | "list" | "records";
  /** One kind per positional argument; when `max` is Infinity the last kind repeats. */
  readonly params: ReadonlyArray<ParamKind>;
  readonly min: number;
  readonly max: number;
  /** Result type from the argument types (a lambda argument contributes its result type). */
  readonly ret: FormulaType | ((args: ReadonlyArray<FormulaType>) => FormulaType);
  /** Replaces the per-parameter type check: a result type, or an error message. */
  readonly rule?: (args: ReadonlyArray<FormulaType>, name: string) => FormulaType | RuleError;
  /** Reserved names that are recognized but not available. */
  readonly unsupported?: true;
  /** Evaluated by the evaluator itself (lazy arguments). */
  readonly special?: true;
  /** Not listed in the reference; reachable only through desugaring. */
  readonly internal?: true;
  readonly volatile?: true;
  readonly lambdaKind?: "boolean" | "any";
  /** Message for an invalid literal argument, or undefined when fine. */
  readonly literal?: (index: number, value: string) => string | undefined;
  /** Rejects pages reached through a relation (they have no readable text). */
  readonly noFar?: true;
  readonly run?: (args: ReadonlyArray<FormulaValue>, rt: Runtime, lambda?: Lambda) => FormulaValue;
}

export const asStr = (v: FormulaValue | undefined): string => plainText(v ?? null) ?? "";
export const asNum = (v: FormulaValue | undefined): number => (typeof v === "number" ? v : 0);
export const asList = (v: FormulaValue | undefined): ReadonlyArray<FormulaValue> =>
  v !== undefined && isListValue(v) ? v : [];
export const asDate = (v: FormulaValue | undefined): DateValue | null =>
  v !== undefined && isDateValue(v) ? v : null;
