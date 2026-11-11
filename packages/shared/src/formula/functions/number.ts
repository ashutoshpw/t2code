import { type FnDef, asList, asNum } from "../fn.ts";
import { clampPlaces, medianOf, roundHalfAway } from "../numbers.ts";
import type { Runtime } from "../runtime.ts";
import { type FormulaType, typeLabel } from "../types.ts";
import { type FormulaValue, type RichText, formatValue, isRich, joinText, num } from "../values.ts";

const NUMERIC = new Set<FormulaType>(["number", "empty", "any"]);

const arithmeticRule: NonNullable<FnDef["rule"]> = ([a = "any", b = "any"], shown) =>
  NUMERIC.has(a) && NUMERIC.has(b)
    ? "number"
    : { error: `Cannot use ${shown} on ${typeLabel(a)} and ${typeLabel(b)}.` };

const binary = (
  name: string,
  description: string,
  example: string,
  op: (a: number, b: number) => number,
): FnDef => ({
  name,
  signature: `${name}(a, b)`,
  description,
  example,
  category: "number",
  params: ["number", "number"],
  min: 2,
  max: 2,
  ret: "number",
  rule: arithmeticRule,
  run: ([a, b]) => num(op(asNum(a), asNum(b))),
});

const unary = (
  name: string,
  description: string,
  example: string,
  op: (a: number) => number,
): FnDef => ({
  name,
  signature: `${name}(number)`,
  description,
  example,
  category: "number",
  params: ["number"],
  min: 1,
  max: 1,
  ret: "number",
  run: ([a]) => num(op(asNum(a))),
});

/** Each argument is a number or a list of numbers; lists are flattened and empty items skipped. */
const numbersOf = (args: ReadonlyArray<FormulaValue>): number[] =>
  args.flatMap((a) =>
    asList(Array.isArray(a) ? a : [a]).filter((x): x is number => typeof x === "number"),
  );

const aggregate = (
  name: string,
  description: string,
  empty: number | null,
  op: (xs: number[]) => number | null,
): FnDef => ({
  name,
  signature: `${name}(number...)`,
  description,
  example: `${name}(1, 2, 3)`,
  category: "number",
  params: ["numArg"],
  min: 1,
  max: Infinity,
  ret: "number",
  run: (args) => {
    const xs = numbersOf(args);
    return xs.length === 0 ? empty : op(xs);
  },
});

export const numberFunctions: ReadonlyArray<FnDef> = [
  {
    name: "add",
    signature: "add(a, b)",
    description: "a + b: adds numbers or joins text.",
    example: "add(1, 2)",
    category: "number",
    params: ["any", "any"],
    min: 2,
    max: 2,
    ret: "any",
    rule: ([a = "any", b = "any"], shown) => {
      if (a === "text" || b === "text") return "text";
      if (NUMERIC.has(a) && NUMERIC.has(b)) return a === "any" || b === "any" ? "any" : "number";
      return { error: `Cannot use ${shown} on ${typeLabel(a)} and ${typeLabel(b)}.` };
    },
    run: ([a, b], rt) => addDynamic(a ?? null, b ?? null, rt),
  },
  binary("subtract", "a - b.", "subtract(5, 2)", (a, b) => a - b),
  binary("multiply", "a * b.", "multiply(3, 4)", (a, b) => a * b),
  {
    ...binary("divide", "a / b. Dividing by zero is empty.", "divide(10, 4)", (a, b) =>
      b === 0 ? NaN : a / b,
    ),
  },
  binary("mod", "The remainder of a / b, with the sign of a.", "mod(7, 3)", (a, b) =>
    b === 0 ? NaN : a % b,
  ),
  binary("pow", "a raised to the power b.", "pow(2, 10)", (a, b) => a ** b),
  aggregate("min", "The smallest of the numbers.", null, (xs) => Math.min(...xs)),
  aggregate("max", "The largest of the numbers.", null, (xs) => Math.max(...xs)),
  aggregate("sum", "The total of the numbers. No numbers give 0.", 0, (xs) =>
    xs.reduce((a, b) => a + b, 0),
  ),
  aggregate(
    "mean",
    "The average of the numbers.",
    null,
    (xs) => xs.reduce((a, b) => a + b, 0) / xs.length,
  ),
  aggregate("median", "The middle of the numbers.", null, (xs) =>
    medianOf([...xs].sort((a, b) => a - b)),
  ),
  unary("abs", "The absolute value.", "abs(-3)", Math.abs),
  unary("ceil", "Rounds up to a whole number.", "ceil(1.2)", Math.ceil),
  unary("floor", "Rounds down to a whole number.", "floor(1.8)", Math.floor),
  unary("sqrt", "The square root.", "sqrt(16)", Math.sqrt),
  unary("cbrt", "The cube root.", "cbrt(27)", Math.cbrt),
  unary("exp", "e raised to the number.", "exp(1)", Math.exp),
  unary("ln", "The natural logarithm.", "ln(e())", Math.log),
  unary("log10", "The base 10 logarithm.", "log10(1000)", Math.log10),
  unary("log2", "The base 2 logarithm.", "log2(8)", Math.log2),
  unary("sign", "-1, 0 or 1 by the sign of the number.", "sign(-5)", Math.sign),
  {
    name: "round",
    signature: "round(number, places?)",
    description: "Rounds to places decimals (0 to 10); halves round away from zero.",
    example: "round(2.675, 2)",
    category: "number",
    params: ["number", "number"],
    min: 1,
    max: 2,
    ret: "number",
    run: ([n, p]) => num(roundHalfAway(asNum(n), typeof p === "number" ? clampPlaces(p) : 0)),
  },
  {
    name: "pi",
    signature: "pi()",
    description: "The number pi.",
    example: "pi()",
    category: "number",
    params: [],
    min: 0,
    max: 0,
    ret: "number",
    run: () => Math.PI,
  },
  {
    name: "e",
    signature: "e()",
    description: "Euler's number.",
    example: "e()",
    category: "number",
    params: [],
    min: 0,
    max: 0,
    ret: "number",
    run: () => Math.E,
  },
];

export function addText(a: FormulaValue, b: FormulaValue, rt: Runtime): FormulaValue {
  if (a === null && b === null) return null;
  const ctx = { timeZone: rt.tz, titleOf: rt.ctx.titleOf, tick: rt.tick };
  const part = (v: FormulaValue): string | RichText =>
    v === null ? "" : typeof v === "string" || isRich(v) ? v : formatValue(v, ctx);
  return joinText(part(a), part(b));
}

/** `+` when static types did not decide: numbers add, any text side concatenates. */
function addDynamic(a: FormulaValue, b: FormulaValue, rt: Runtime): FormulaValue {
  if (typeof a === "number" && typeof b === "number") return num(a + b);
  if (typeof a === "string" || isRich(a) || typeof b === "string" || isRich(b))
    return addText(a, b, rt);
  return null;
}
