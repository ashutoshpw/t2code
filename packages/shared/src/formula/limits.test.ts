// @effect-diagnostics nodeBuiltinImport:off - the sandbox test reads this module's own source files.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { compile, evaluate, parse, completions, type FormulaValue } from "./index.ts";
import { context, errors, ev, schema } from "./testkit.ts";

function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCABULARY = [
  "1",
  "0",
  "2.5",
  "1e400",
  '"a"',
  '"(a+)+$"',
  '"\\\\d"',
  '"%"',
  "true",
  "false",
  "(",
  ")",
  "[",
  "]",
  ",",
  ".",
  "?",
  ":",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "==",
  "!=",
  "<",
  ">=",
  "!",
  "&&",
  "||",
  "and",
  "or",
  "not",
  "if",
  "ifs",
  "let",
  "lets",
  "map",
  "filter",
  "sort",
  "current",
  "index",
  "x",
  "prop",
  '"Count"',
  '"Name"',
  '"Tags"',
  '"Project"',
  '"Due"',
  "now",
  "today",
  "length",
  "substring",
  "split",
  "join",
  "test",
  "replaceAll",
  "dateAdd",
  "dateBetween",
  "formatDate",
  "formatNumber",
  "concat",
  "flat",
  "unique",
  "sum",
  "empty",
  "format",
  "toNumber",
  "repeat",
  "padStart",
  "style",
  "at",
  "slice",
  "'",
  '"',
  "/*",
  "//",
  "\n",
  " ",
  "\u{1F600}",
  "#",
  "=",
  "&",
  "|",
  "\\",
];

function randomSource(next: () => number): string {
  const n = 1 + Math.floor(next() * 24);
  return Array.from(
    { length: n },
    () => VOCABULARY[Math.floor(next() * VOCABULARY.length)] ?? "",
  ).join(" ");
}

function plain(value: FormulaValue): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(plain);
  return typeof value === "object";
}

describe("limits", () => {
  it("costs one step per node and stops when the budget is spent", () => {
    expect(ev("1 + 2", {}, { maxSteps: 3 })).toBe(3);
    expect(ev("1 + 2", {}, { maxSteps: 2 })).toBeNull();
    expect(ev("[1, 2, 3].map(current)", {}, { maxSteps: 100 })).toEqual([1, 2, 3]);
    expect(ev("[1, 2, 3].map(current)", {}, { maxSteps: 6 })).toBeNull();
  });

  it("adds the steps of every evaluation to the caller's meter", () => {
    const meter = { steps: 0 };
    ev("1 + 2", {}, { meter });
    ev("1 + 2", {}, { meter, maxSteps: 2 });
    expect(meter.steps).toBe(3 + 3);
  });

  it("charges size-heavy calls inside lambdas against the step budget", () => {
    const flat =
      'lets(a,"x".repeat(1000).split(""), b,a.map(a), a.map(b.flat().length()).length())';
    const join =
      'lets(a,"x".repeat(1000).split(""), s,"x".repeat(16384), b,a.map(s), a.map(b.join(s).length()).length())';
    const split =
      'lets(a,"x".repeat(1000).split(""), s,"x".repeat(16384), a.map(s.split("").join(s).length()).length())';
    for (const source of [flat, join, split]) {
      expect(ev(source)).toBeNull();
      expect(ev(source, {}, { maxSteps: 1_000_000 })).toBeNull();
    }
    expect(ev('join(["a","b"], "-")')).toBe("a-b");
    expect(ev("flat([[1], [2, 3]])")).toEqual([1, 2, 3]);
  });

  it("returns empty for work that would run far beyond the default budget", () => {
    const big = 'split(repeat("a,", 999))';
    expect(ev(`${big}.map(${big}.map(current)).length()`)).toBeNull();
    expect(ev(`${big}.map(current).length()`)).toBe(1000);
  });

  describe("shared nested lists", () => {
    const ten = "[1,2,3,4,5,6,7,8,9,10]";
    const x10 = (n: string) => `[${Array(10).fill(n).join(",")}]`;
    const cat = (n: string) => `${n}.concat(${Array(9).fill(n).join(",")})`;
    const deep = (tail: string) =>
      `lets(a,${ten},b,${cat("a")},c,${cat("b")},d,${x10("c")},e,${x10("d")},f,${x10("e")},g,${x10("f")},h,${x10("g")},${tail})`;

    it("charges the walk of format, equality and unique", () => {
      expect(ev(deep("format(h).length()"))).toBeNull();
      expect(ev(deep("h == h"))).toBeNull();
      expect(ev(deep(`${x10("h")}.unique().length()`))).toBeNull();
    });

    it("returns empty for a result with more than 10,000 reachable nodes", () => {
      expect(ev(deep("h"))).toBeNull();
      expect(ev("[[1,2,3],[4,5]]")).toEqual([
        [1, 2, 3],
        [4, 5],
      ]);
    });
  });

  it("does not let source call the internal addText", () => {
    expect(errors("addText(1, 2)")).toEqual(['There is no function named "addText".']);
    expect(ev('"a" + "b"')).toBe("ab");
  });

  it("accepts a source of exactly 8,192 characters and rejects one more", () => {
    expect(compile(`1${" ".repeat(8191)}`, schema).diagnostics).toEqual([]);
    expect(compile(`1${" ".repeat(8192)}`, schema).diagnostics[0]).toMatchObject({
      code: "limit",
      message: "The formula is too long.",
    });
  });

  it("reports limit errors with a span inside the source", () => {
    const source = `${"(".repeat(80)}1${")".repeat(80)}`;
    const d = compile(source, schema).diagnostics[0];
    expect(d?.code).toBe("limit");
    expect(d && d.start >= 0 && d.end <= source.length && d.end > d.start).toBe(true);
  });

  it("never throws, whatever the context does", () => {
    const compiled = compile(
      'prop("Count") + length(prop("Project").map(current.prop("Budget")))',
      schema,
    ).compiled;
    if (compiled === null) throw new Error("compile");
    const boom = () => {
      throw new Error("boom");
    };
    expect(evaluate(compiled, { ...context(), read: boom })).toBeNull();
    expect(evaluate(compiled, { ...context(), titleOf: boom })).toBeNull();
    const titled = compile('format(prop("Project"))', schema).compiled;
    if (titled === null) throw new Error("compile");
    const store = { row1: { t_project: [{ kind: "page" as const, id: "p", ds: "projects" }] } };
    expect(evaluate(titled, { ...context(store), titleOf: boom })).toBeNull();
    expect(evaluate(compiled, { ...context(), timeZone: "garbage" })).toEqual(
      evaluate(compiled, context()),
    );
  });

  it("parses, checks, evaluates and completes random token streams without throwing", () => {
    const next = prng(20240315);
    let compiledCount = 0;
    for (let i = 0; i < 3000; i += 1) {
      const source = randomSource(next);
      expect(() => parse(source)).not.toThrow();
      const result = compile(source, schema);
      for (const d of result.diagnostics) {
        expect(d.end).toBeGreaterThan(d.start);
        expect(d.message).not.toBe("");
      }
      expect(() =>
        completions(source, Math.floor(next() * (source.length + 1)), schema),
      ).not.toThrow();
      if (result.compiled === null) continue;
      compiledCount += 1;
      const value = evaluate(result.compiled, context({}, { maxSteps: 200 }));
      expect(plain(value)).toBe(true);
      expect(evaluate(result.compiled, context({}, { maxSteps: 200 }))).toEqual(value);
    }
    expect(compiledCount).toBeGreaterThan(50);
  });

  it("evaluates every node shape of a larger program deterministically", () => {
    const source = String.raw`lets(
      items, split("b,a,c"),
      sorted, sort(items),
      total, sum([1, 2, 3].map(current * index)),
      label, ifs(total > 100, "big", total > 1, "some", "none"),
      join(sorted, "-") + ":" + label + ":" + formatNumber(total / 7, "number", 2)
    )`;
    expect(ev(source)).toBe("a-b-c:some:1.14");
    expect(ev(source)).toBe(ev(source));
  });
});

describe("sandbox", () => {
  const dir = new URL(".", import.meta.url);
  const files = [
    ...NodeFS.readdirSync(dir).filter((f) => f.endsWith(".ts")),
    ...NodeFS.readdirSync(new URL("functions/", dir)).map((f) => `functions/${f}`),
  ].filter((f) => !f.endsWith(".test.ts") && f !== "testkit.ts");

  it("uses no dynamic code, wall clock, locale APIs or foreign imports", () => {
    expect(files.length).toBeGreaterThan(15);
    const banned = [
      /\beval\s*\(/,
      /new\s+Function\b/,
      /\bFunction\s*\(/,
      /\bnew\s+RegExp\b/,
      /\bRegExp\s*\(/,
      /Date\.now/,
      /new\s+Date\b/,
      /localeCompare/,
      /toLocale/,
      /\bimport\s*\(/,
      /from\s+["'](?!\.)/,
      /@t2code\//,
    ];
    for (const file of files) {
      const text = NodeFS.readFileSync(new URL(file, dir), "utf8");
      for (const pattern of banned) {
        expect(pattern.test(text), `${file} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("keeps every file under 800 lines", () => {
    for (const file of files) {
      expect(NodeFS.readFileSync(new URL(file, dir), "utf8").split("\n").length, file).toBeLessThan(
        800,
      );
    }
  });
});
