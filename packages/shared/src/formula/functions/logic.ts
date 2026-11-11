import type { FnDef, RuleError } from "../fn.ts";
import { type FormulaType, isListType, isPageType, typeLabel, unify } from "../types.ts";
import {
  type FormulaValue,
  compareValues,
  isDateValue,
  isEmptyValue,
  isPageValue,
  plainText,
  valuesEqual,
  instantOf,
} from "../values.ts";

const isBoolish = (t: FormulaType): boolean => t === "boolean" || t === "any" || t === "empty";
const COMPARABLE = new Set<FormulaType>(["number", "text", "boolean", "date", "any", "empty"]);

const expectBool = (name: string, t: FormulaType, arg: number): RuleError | undefined =>
  isBoolish(t) ? undefined : { error: `${name} expects boolean here, got ${typeLabel(t)}.`, arg };

type Rule = NonNullable<FnDef["rule"]>;

const equalityRule: Rule = ([a = "any", b = "any"]) =>
  unify(a, b) === undefined
    ? { error: `Cannot compare ${typeLabel(a)} with ${typeLabel(b)}.` }
    : "boolean";

const orderRule: Rule = ([a = "any", b = "any"]) => {
  const u = unify(a, b);
  if (u === undefined || typeof u !== "string" || !COMPARABLE.has(u)) {
    return { error: `Cannot compare ${typeLabel(a)} with ${typeLabel(b)}.` };
  }
  return "boolean";
};

function ordered(a: FormulaValue, b: FormulaValue, tz: string): number | null {
  if (a === null || b === null) return null;
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  if (isDateValue(a) && isDateValue(b)) {
    const x = instantOf(a, a.start, tz);
    const y = instantOf(b, b.start, tz);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  const ta = plainText(a);
  const tb = plainText(b);
  if (ta !== null && tb !== null) return compareValues(ta, tb, tz);
  return null;
}

const order = (name: string, op: string, test: (c: number) => boolean): FnDef => ({
  name,
  signature: `${name}(a, b)`,
  description: `a ${op} b for numbers, text, dates and checkboxes. Empty gives false.`,
  example: `${name}(1, 2)`,
  category: "logic",
  params: ["any", "any"],
  min: 2,
  max: 2,
  ret: "boolean",
  rule: orderRule,
  run: ([a, b], rt) => {
    const c = ordered(a ?? null, b ?? null, rt.tz);
    return c !== null && test(c);
  },
});

export const logicFunctions: ReadonlyArray<FnDef> = [
  {
    name: "if",
    signature: "if(condition, then, else)",
    description: "then when the condition is true, otherwise else. Also condition ? then : else.",
    example: 'if(prop("Done"), "Yes", "No")',
    category: "logic",
    params: ["boolean", "any", "any"],
    min: 3,
    max: 3,
    special: true,
    ret: "any",
    rule: ([c = "any", a = "any", b = "any"]) => {
      const bad = expectBool("if", c, 0);
      if (bad !== undefined) return bad;
      return (
        unify(a, b) ?? {
          error: `Both results of if must be the same type, got ${typeLabel(a)} and ${typeLabel(b)}.`,
          arg: 2,
        }
      );
    },
  },
  {
    name: "ifs",
    signature: "ifs(condition, value, ..., fallback?)",
    description: "The value of the first true condition, or the fallback.",
    example: 'ifs(prop("Count") > 10, "big", prop("Count") > 5, "medium", "small")',
    category: "logic",
    params: ["boolean", "any"],
    min: 2,
    max: Infinity,
    special: true,
    ret: "any",
    rule: (types) => {
      let result: FormulaType = "empty";
      const pairs = Math.floor(types.length / 2);
      for (let i = 0; i < pairs; i += 1) {
        const bad = expectBool("ifs", types[i * 2] ?? "any", i * 2);
        if (bad !== undefined) return bad;
      }
      const values = types.filter(
        (_, i) =>
          (i % 2 === 1 && i < pairs * 2) || (types.length % 2 === 1 && i === types.length - 1),
      );
      for (const v of values) {
        const u = unify(result, v);
        if (u === undefined) {
          return {
            error: `All results of ifs must be the same type, got ${typeLabel(result)} and ${typeLabel(v)}.`,
          };
        }
        result = u;
      }
      return result;
    },
  },
  {
    name: "let",
    signature: "let(name, value, expression)",
    description: "Names a value for use in the expression.",
    example: "let(x, 5, x * 2)",
    category: "logic",
    params: ["any", "any", "any"],
    min: 3,
    max: 3,
    special: true,
    ret: "any",
  },
  {
    name: "lets",
    signature: "lets(name, value, ..., expression)",
    description: "Names several values; later ones can use earlier ones.",
    example: "lets(a, 2, b, a * 3, a + b)",
    category: "logic",
    params: ["any"],
    min: 3,
    max: Infinity,
    special: true,
    ret: "any",
  },
  {
    name: "empty",
    signature: "empty(value?)",
    description: "Whether the value is empty. With no argument it is the empty value.",
    example: 'empty(prop("Notes"))',
    category: "logic",
    params: ["any"],
    min: 0,
    max: 1,
    ret: (args) => (args.length === 0 ? "empty" : "boolean"),
    run: (args) => (args.length === 0 ? null : isEmptyValue(args[0] ?? null)),
  },
  {
    name: "equal",
    signature: "equal(a, b)",
    description: "a == b.",
    example: "equal(1, 1)",
    category: "logic",
    params: ["any", "any"],
    min: 2,
    max: 2,
    ret: "boolean",
    rule: equalityRule,
    run: ([a, b], rt) => valuesEqual(a ?? null, b ?? null, rt.tz, rt.tick),
  },
  {
    name: "unequal",
    signature: "unequal(a, b)",
    description: "a != b.",
    example: "unequal(1, 2)",
    category: "logic",
    params: ["any", "any"],
    min: 2,
    max: 2,
    ret: "boolean",
    rule: equalityRule,
    run: ([a, b], rt) => !valuesEqual(a ?? null, b ?? null, rt.tz, rt.tick),
  },
  order("larger", ">", (c) => c > 0),
  order("largerEq", ">=", (c) => c >= 0),
  order("smaller", "<", (c) => c < 0),
  order("smallerEq", "<=", (c) => c <= 0),
  ...(["and", "or"] as const).map((name): FnDef => ({
    name,
    signature: `${name}(a, b, ...)`,
    description:
      name === "and" ? "True when every argument is true." : "True when any argument is true.",
    example: `${name}(true, false)`,
    category: "logic",
    params: ["boolean"],
    min: 2,
    max: Infinity,
    special: true,
    ret: "boolean",
    rule: (types, shown) => {
      for (const [i, t] of types.entries()) {
        const bad = expectBool(shown, t, i);
        if (bad !== undefined) return bad;
      }
      return "boolean";
    },
  })),
  {
    name: "not",
    signature: "not(value)",
    description: "True when the value is false.",
    example: "not(true)",
    category: "logic",
    params: ["boolean"],
    min: 1,
    max: 1,
    ret: "boolean",
    run: ([v]) => v !== true,
  },
  {
    name: "id",
    signature: "id(page?)",
    description: "The id of a page. With no argument, the id of this row.",
    example: "id()",
    category: "records",
    params: ["any"],
    min: 0,
    max: 1,
    ret: "text",
    rule: ([a]) => {
      if (a === undefined || a === "any" || a === "empty" || (isPageType(a) && !isListType(a)))
        return "text";
      return { error: `id expects page here, got ${typeLabel(a)}.`, arg: 0 };
    },
    run: (args, rt) => {
      if (args.length === 0) return rt.ctx.row.id;
      const page = args[0] ?? null;
      return page !== null && isPageValue(page) ? page.id : null;
    },
  },
  ...(["name", "email"] as const).map((name): FnDef => ({
    name,
    signature: `${name}(person)`,
    description: "People properties are not supported.",
    example: `${name}(prop("Person"))`,
    category: "records",
    params: ["any"],
    min: 1,
    max: 1,
    ret: "any",
    unsupported: true,
  })),
];
