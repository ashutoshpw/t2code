import { type FnDef, asList, asNum } from "../fn.ts";
import { type FormulaType, elementType, isListType, typeLabel, unify } from "../types.ts";
import {
  type FormulaValue,
  MAX_LIST,
  capList,
  compareValues,
  isListValue,
  valueKey,
  valuesEqual,
} from "../values.ts";

const elementOf = (t: FormulaType | undefined): FormulaType =>
  t === undefined ? "any" : (elementType(t) ?? "any");

const lambdaFn = (
  name: string,
  signature: string,
  description: string,
  example: string,
  kind: "boolean" | "any",
  ret: FnDef["ret"],
  run: NonNullable<FnDef["run"]>,
  optional = false,
): FnDef => ({
  name,
  signature,
  description,
  example,
  category: "list",
  params: ["list", "lambda"],
  min: optional ? 1 : 2,
  max: 2,
  ret,
  lambdaKind: kind,
  run,
});

const trunc = (n: number): number => Math.trunc(n);

export const listFunctions: ReadonlyArray<FnDef> = [
  {
    name: "at",
    signature: "at(list, index)",
    description: "The item at index, counting from 0. Negative counts from the end.",
    example: "at([1, 2, 3], -1)",
    category: "list",
    params: ["list", "number"],
    min: 2,
    max: 2,
    ret: (a) => elementOf(a[0]),
    run: ([l, i]) => {
      const list = asList(l);
      const idx = trunc(asNum(i));
      return list[idx < 0 ? list.length + idx : idx] ?? null;
    },
  },
  {
    name: "first",
    signature: "first(list)",
    description: "The first item.",
    example: "first([1, 2, 3])",
    category: "list",
    params: ["list"],
    min: 1,
    max: 1,
    ret: (a) => elementOf(a[0]),
    run: ([l]) => asList(l)[0] ?? null,
  },
  {
    name: "last",
    signature: "last(list)",
    description: "The last item.",
    example: "last([1, 2, 3])",
    category: "list",
    params: ["list"],
    min: 1,
    max: 1,
    ret: (a) => elementOf(a[0]),
    run: ([l]) => {
      const list = asList(l);
      return list[list.length - 1] ?? null;
    },
  },
  {
    name: "slice",
    signature: "slice(list, start, end?)",
    description: "A part of the list from start up to, but not including, end.",
    example: "slice([1, 2, 3, 4], 1, 3)",
    category: "list",
    params: ["list", "number", "number"],
    min: 2,
    max: 3,
    ret: (a) => a[0] ?? "any",
    run: ([l, s, e]) =>
      asList(l).slice(trunc(asNum(s)), typeof e === "number" ? trunc(e) : undefined),
  },
  {
    name: "concat",
    signature: "concat(list, list...)",
    description: "Joins lists. A value that is not a list is added as one item.",
    example: "concat([1], [2, 3])",
    category: "list",
    params: ["list", "any"],
    min: 1,
    max: Infinity,
    ret: "any",
    rule: (types) => {
      let item: FormulaType = "empty";
      for (const t of types) {
        const e = isListType(t) ? t.list : t;
        item = unify(item, e) ?? "any";
      }
      const first = types[0];
      if (first !== undefined && !isListType(first) && first !== "any" && first !== "empty") {
        return { error: `concat expects list here, got ${typeLabel(first)}.`, arg: 0 };
      }
      return { list: item };
    },
    run: ([first, ...rest]) => {
      const out: FormulaValue[] = [...asList(first)];
      for (const r of rest) {
        if (r === null) continue;
        if (isListValue(r)) out.push(...r);
        else out.push(r);
        if (out.length > MAX_LIST) break;
      }
      return capList(out);
    },
  },
  lambdaFn(
    "sort",
    "sort(list, key?)",
    "Sorts ascending; empty values last. With a key expression, sorts by its result using current.",
    'sort(prop("Tags"))',
    "any",
    (a) => a[0] ?? "any",
    ([l], rt, lambda) => {
      const list = asList(l);
      const keyed = list.map((item, index) => ({
        item,
        index,
        key: lambda === undefined ? item : lambda(item, index),
      }));
      keyed.sort((x, y) => compareValues(x.key, y.key, rt.tz, rt.tick) || x.index - y.index);
      return keyed.map((k) => k.item);
    },
    true,
  ),
  {
    name: "reverse",
    signature: "reverse(list)",
    description: "The list in reverse order.",
    example: "reverse([1, 2, 3])",
    category: "list",
    params: ["list"],
    min: 1,
    max: 1,
    ret: (a) => a[0] ?? "any",
    run: ([l]) => [...asList(l)].reverse(),
  },
  {
    name: "unique",
    signature: "unique(list)",
    description: "The list without repeated items.",
    example: "unique([1, 1, 2])",
    category: "list",
    params: ["list"],
    min: 1,
    max: 1,
    ret: (a) => a[0] ?? "any",
    run: ([l], rt) => {
      const seen = new Set<string>();
      return asList(l).filter((item) => {
        const key = valueKey(item, rt.tz, rt.tick);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
  },
  {
    name: "includes",
    signature: "includes(list, value)",
    description: "Whether the list contains the value.",
    example: 'includes(prop("Tags"), "Urgent")',
    category: "list",
    params: ["list", "any"],
    min: 2,
    max: 2,
    ret: "boolean",
    rule: ([l = "any", v = "any"]) => {
      const e = elementOf(l);
      return unify(e, v) === undefined
        ? { error: `Cannot compare ${typeLabel(e)} with ${typeLabel(v)}.`, arg: 1 }
        : "boolean";
    },
    run: ([l, v], rt) => asList(l).some((item) => valuesEqual(item, v ?? null, rt.tz, rt.tick)),
  },
  lambdaFn(
    "find",
    "find(list, test)",
    "The first item for which the test is true.",
    "find([1, 2, 3], current > 1)",
    "boolean",
    (a) => elementOf(a[0]),
    ([l], _rt, lambda) => {
      const list = asList(l);
      for (const [i, item] of list.entries()) if (lambda?.(item, i) === true) return item;
      return null;
    },
  ),
  lambdaFn(
    "findIndex",
    "findIndex(list, test)",
    "The index of the first item for which the test is true, or -1.",
    "findIndex([1, 2, 3], current > 1)",
    "boolean",
    "number",
    ([l], _rt, lambda) => {
      const list = asList(l);
      for (const [i, item] of list.entries()) if (lambda?.(item, i) === true) return i;
      return -1;
    },
  ),
  lambdaFn(
    "filter",
    "filter(list, test)",
    "The items for which the test is true.",
    "filter([1, 2, 3], current > 1)",
    "boolean",
    (a) => a[0] ?? "any",
    ([l], _rt, lambda) => asList(l).filter((item, i) => lambda?.(item, i) === true),
  ),
  lambdaFn(
    "some",
    "some(list, test)",
    "Whether the test is true for any item.",
    "some([1, 2, 3], current > 2)",
    "boolean",
    "boolean",
    ([l], _rt, lambda) => asList(l).some((item, i) => lambda?.(item, i) === true),
  ),
  lambdaFn(
    "every",
    "every(list, test)",
    "Whether the test is true for every item.",
    "every([1, 2, 3], current > 0)",
    "boolean",
    "boolean",
    ([l], _rt, lambda) => asList(l).every((item, i) => lambda?.(item, i) === true),
  ),
  lambdaFn(
    "map",
    "map(list, expression)",
    "A list of the expression's result for each item. Use current and index.",
    "map([1, 2, 3], current * 2)",
    "any",
    (a) => ({ list: a[1] ?? "any" }),
    ([l], _rt, lambda) => capList(asList(l).map((item, i) => lambda?.(item, i) ?? null)),
  ),
  {
    name: "flat",
    signature: "flat(list)",
    description: "Flattens one level of nested lists.",
    example: "flat([[1], [2, 3]])",
    category: "list",
    params: ["list"],
    min: 1,
    max: 1,
    ret: (a) => {
      const e = elementOf(a[0]);
      return { list: isListType(e) ? e.list : e };
    },
    run: ([l], rt) => {
      const out: FormulaValue[] = [];
      for (const item of asList(l)) {
        if (!isListValue(item)) {
          out.push(item);
        } else {
          rt.tick(Math.ceil(item.length / 256));
          for (const x of item) {
            out.push(x);
            if (out.length >= MAX_LIST) return out;
          }
        }
        if (out.length >= MAX_LIST) break;
      }
      return capList(out);
    },
  },
];
