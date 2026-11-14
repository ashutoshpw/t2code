import { normalizeZone } from "./dates.ts";
import { formatValue as formatFormulaValue } from "./values.ts";
import type { EvalContext } from "./runtime.ts";
import type { FormulaValue } from "./values.ts";

export { completions, type FormulaCompletion } from "./complete.ts";
export { compile, recheck, type CheckResult, type CompiledFormula } from "./check.ts";
export { evaluate } from "./evaluate.ts";
export type { BoundNode, ParsedNode } from "./ast.ts";
export { parse } from "./parser.ts";
export { FUNCTIONS, type FormulaFunctionDoc } from "./registry.ts";
export { renderSource } from "./render.ts";
export {
  evaluateRollup,
  rollupFunctionsFor,
  rollupResultType,
  type RollupFunction,
} from "./rollup.ts";
export type { EvalContext } from "./runtime.ts";
export {
  FORMULA_VERSION,
  typeLabel,
  type FormulaDeps,
  type FormulaDiagnostic,
  type FormulaErrorCode,
  type FormulaProperty,
  type FormulaRef,
  type FormulaSchema,
  type FormulaType,
} from "./types.ts";
export type { DateValue, FormulaValue, PageValue, RichText, Run } from "./values.ts";

export function formatValue(
  value: FormulaValue,
  context: Pick<EvalContext, "timeZone" | "titleOf">,
): string {
  return formatFormulaValue(value, {
    timeZone: normalizeZone(context.timeZone),
    titleOf: context.titleOf,
  });
}
