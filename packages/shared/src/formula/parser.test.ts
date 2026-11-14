import { describe, expect, it } from "vite-plus/test";
import type { ParsedNode } from "./ast.ts";
import { parse } from "./index.ts";
import { ev } from "./testkit.ts";

function show(node: ParsedNode): string {
  switch (node.k) {
    case "num":
      return String(node.v);
    case "str":
      return JSON.stringify(node.v);
    case "bool":
      return String(node.v);
    case "var":
      return node.name;
    case "prop":
      return node.of === undefined ? `@${node.name}` : `${show(node.of)}.@${node.name}`;
    case "list":
      return `[${node.items.map(show).join(" ")}]`;
    case "call":
      return `(${node.fn}${node.args.map((a) => ` ${show(a)}`).join("")})`;
  }
}

const tree = (source: string): string => {
  const { ast, diagnostics } = parse(source);
  if (ast === null) throw new Error(diagnostics.map((d) => d.message).join("|"));
  return show(ast);
};

const failure = (source: string) => {
  const { ast, diagnostics } = parse(source);
  expect(ast).toBeNull();
  const d = diagnostics[0];
  if (d === undefined) throw new Error("expected a diagnostic");
  return { code: d.code, message: d.message, text: source.slice(d.start, d.end) };
};

describe("lexer", () => {
  it.each([
    ["42", 42],
    ["3.25", 3.25],
    [".5", 0.5],
    ["1e3", 1000],
    ["1.5E-2", 0.015],
    ["2e+2", 200],
  ])("reads the number %s", (source, expected) => {
    expect(ev(source)).toBe(expected);
  });

  it.each([
    [String.raw`"a\"b"`, 'a"b'],
    [String.raw`"a\\b"`, "a\\b"],
    [String.raw`"a\nb"`, "a\nb"],
    [String.raw`"a\tb"`, "a\tb"],
    [String.raw`"a\rb"`, "a\rb"],
    [String.raw`"Aé"`, "Aé"],
    ['"multi\nline"', "multi\nline"],
  ])("decodes text %s", (source, expected) => {
    expect(ev(source)).toBe(expected);
  });

  it("skips comments and whitespace including U+00A0", () => {
    expect(ev("1 /* two */ + // three\n 4")).toBe(5);
    expect(ev("1 + 2")).toBe(3);
    expect(tree("1 /* a */")).toBe("1");
  });

  it("keeps a slash that is not a comment as division", () => {
    expect(ev("6 / 3")).toBe(2);
  });

  it("treats the empty source, whitespace and a lone comment as the empty value", () => {
    for (const source of ["", "   \n", "// nothing", "/* nothing */"]) {
      expect(tree(source)).toBe("(empty)");
      expect(ev(source)).toBeNull();
    }
  });

  it.each([
    ["'a'", "syntax", "Text must use double quotes.", "'a'"],
    ['"abc', "syntax", "Unterminated text.", '"abc'],
    [
      String.raw`"a\qb"`,
      "syntax",
      String.raw`Unknown escape "\q". Write "\\q" for a backslash.`,
      String.raw`\q`,
    ],
    ["1 /* open", "syntax", "Unterminated comment.", "/* open"],
    ["1 # 2", "syntax", 'Unexpected "#".', "#"],
    ["1 = 2", "syntax", 'Unexpected "=".', "="],
    ["1 & 2", "syntax", 'Unexpected "&".', "&"],
    ["2abc", "syntax", 'Unexpected "a".', "a"],
  ])("reports %s", (source, code, message, text) => {
    expect(failure(source)).toEqual({ code, message, text });
  });
});

describe("parser", () => {
  it.each([
    ["2 + 3 * 4", "(add 2 (multiply 3 4))"],
    ["2 * 3 + 4", "(add (multiply 2 3) 4)"],
    ["10 - 3 - 2", "(subtract (subtract 10 3) 2)"],
    ["100 / 10 / 5", "(divide (divide 100 10) 5)"],
    ["7 % 4 * 2", "(multiply (mod 7 4) 2)"],
    ["2 ^ 3 ^ 2", "(pow 2 (pow 3 2))"],
    ["-2 ^ 2", "(subtract 0 (pow 2 2))"],
    ["2 ^ -1", "(pow 2 -1)"],
    ["-5", "-5"],
    ["--5", "5"],
    ["- 2 * 3", "(multiply -2 3)"],
    ["not true == false", "(equal (not true) false)"],
    ["!true", "(not true)"],
    ["1 < 2 == true", "(equal (smaller 1 2) true)"],
    ["1 + 2 < 4", "(smaller (add 1 2) 4)"],
    ["true or false and false", "(or true (and false false))"],
    ["true || false && false", "(or true (and false false))"],
    ["a and b and c", "(and (and a b) c)"],
    ["true ? 1 : false ? 2 : 3", "(if true 1 (if false 2 3))"],
    ["a ? b : c ? d : e", "(if a b (if c d e))"],
    ["(1 + 2) * 3", "(multiply (add 1 2) 3)"],
    ["1 >= 2 != 3 <= 4", "(unequal (largerEq 1 2) (smallerEq 3 4))"],
    ["+x", "(multiply 1 x)"],
  ])("parses %s", (source, expected) => {
    expect(tree(source)).toBe(expected);
  });

  it("evaluates the precedence table to the expected values", () => {
    expect(ev("2 + 3 * 4")).toBe(14);
    expect(ev("-2 ^ 2")).toBe(-4);
    expect(ev("2 ^ 3 ^ 2")).toBe(512);
    expect(ev("not true == false")).toBe(true);
    expect(ev("true ? 1 : false ? 2 : 3")).toBe(1);
    expect(ev("false ? 1 : false ? 2 : 3")).toBe(3);
    expect(ev("true or false and false")).toBe(true);
    expect(ev("false and true or true")).toBe(true);
    expect(ev("10 - 4 - 3")).toBe(3);
  });

  it.each([
    ['"abc".upper()', '(upper "abc")'],
    ["[1, 2].length", "(length [1 2])"],
    ['"a".replace("a", "b").upper()', '(upper (replace "a" "a" "b"))'],
    ["x.f(1).g", "(g (f x 1))"],
    ['prop("A").length', "(length @A)"],
    ['first(prop("A")).prop("B")', "(first @A).@B"],
    ["[1, 2, 3,]", "[1 2 3]"],
    ["[]", "[]"],
    ["let(x, 1, x)", "(let x 1 x)"],
    ["and(a, b)", "(and a b)"],
    ["x.not()", "(not x)"],
  ])("desugars %s", (source, expected) => {
    expect(tree(source)).toBe(expected);
  });

  it("keeps spans on every node", () => {
    const source = 'if(1 > 2, "a", "b")';
    const { ast } = parse(source);
    expect(ast && source.slice(ast.s, ast.e)).toBe(source);
    const dotted = "x.f(1)";
    expect(parse(dotted).ast).toMatchObject({ s: 0, e: dotted.length });
  });

  it.each([
    ["1 +", "Expected an expression."],
    ["(1", 'Missing closing ")".'],
    ["f(1, 2", 'Missing closing ")".'],
    ["[1, 2", 'Missing closing "]".'],
    ["1 2", 'Unexpected "2".'],
    ["1 )", 'Unexpected ")".'],
    ["* 2", 'Unexpected "*".'],
    ["a ? b", 'Expected ":".'],
    ["f(,)", 'Unexpected ",".'],
    ["a.", "Expected a function name."],
    ["a.1", 'Unexpected ".1".'],
    ["prop(1)", "prop() takes a property name in double quotes."],
    ["prop(x)", "prop() takes a property name in double quotes."],
    ['prop("A", 1)', "prop() takes a property name in double quotes."],
    ["a.prop", "prop() takes a property name in double quotes."],
    ["not", "Expected an expression."],
  ])("explains %s", (source, message) => {
    expect(failure(source).message).toBe(message);
  });

  it("points syntax errors at the offending text", () => {
    expect(failure("1 2").text).toBe("2");
    expect(failure("(1").text).toBe("(");
    expect(failure("prop(1)").text).toBe("1");
  });

  it("reports limits", () => {
    expect(failure(`${"(".repeat(70)}1${")".repeat(70)}`)).toMatchObject({
      code: "limit",
      message: "The formula is nested too deeply.",
    });
    expect(parse(`${"(".repeat(20)}1${")".repeat(20)}`).ast).not.toBeNull();
    expect(failure(Array.from({ length: 1100 }, () => "1").join("+"))).toMatchObject({
      code: "limit",
      message: "The formula is too long.",
    });
    expect(failure(`[${Array.from({ length: 101 }, () => "1").join(",")}]`).code).toBe("limit");
    expect(parse(`[${Array.from({ length: 100 }, () => "1").join(",")}]`).ast).not.toBeNull();
    expect(failure("1".repeat(8193))).toMatchObject({
      code: "limit",
      message: "The formula is too long.",
    });
  });

  it("never throws on malformed input", () => {
    for (const source of [
      "(((",
      "]]]",
      '"',
      "'",
      "/*",
      "\\",
      "\u0000",
      "f(",
      "a.b.(",
      "?:",
      "1..2",
      "x.y.z.w(",
    ]) {
      expect(() => parse(source)).not.toThrow();
    }
  });
});
