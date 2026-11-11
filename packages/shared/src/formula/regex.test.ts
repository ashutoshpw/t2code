import { describe, expect, it } from "vite-plus/test";
import { compileRegex, execRegex, toCodePoints } from "./regex.ts";
import { ev } from "./testkit.ts";

const quiet = { add: () => undefined };

function search(pattern: string, text: string, from = 0): string[] | null {
  const compiled = compileRegex(pattern);
  if (!compiled.ok) throw new Error(compiled.reason);
  const cps = toCodePoints(text);
  const slots = execRegex(compiled.program, cps, from, quiet);
  if (slots === null) return null;
  const out: string[] = [];
  for (let g = 0; g * 2 < slots.length; g += 1) {
    const a = slots[g * 2] ?? -1;
    const b = slots[g * 2 + 1] ?? -1;
    out.push(a < 0 || b < 0 ? "" : String.fromCodePoint(...cps.slice(a, b)));
  }
  return out;
}

const whole = (pattern: string, text: string): string | null => search(pattern, text)?.[0] ?? null;
const reason = (pattern: string): string | undefined => {
  const c = compileRegex(pattern);
  return c.ok ? undefined : c.reason;
};

describe("supported syntax", () => {
  it.each([
    ["abc", "xxabcxx", "abc"],
    ["abc", "ab", null],
    ["a.c", "abc", "abc"],
    ["a.c", "a\nc", null],
    ["a.c", "a\u{1F600}c", "a\u{1F600}c"],
    ["[a-c]+", "xxabcabx", "abcab"],
    ["[^a-c]+", "abxyzab", "xyz"],
    ["[\\d-]+", "ab12-3c", "12-3"],
    ["[a\\]]+", "x]a]y", "]a]"],
    ["[]a]", "a", null],
    ["[^]", "\n", "\n"],
    ["[\\w.]+", "!!a.b_c!!", "a.b_c"],
    ["[\\s\\S]+", "a\nb", "a\nb"],
    ["[\\D]+", "12ab34", "ab"],
    ["[a-]+", "a-a", "a-a"],
    ["[-a]+", "a-a", "a-a"],
    ["\\d+", "abc123def", "123"],
    ["\\D+", "12ab34", "ab"],
    ["\\w+", "  hello_1 ", "hello_1"],
    ["\\W+", "ab, cd", ", "],
    ["\\s+", "ab \t\ncd", " \t\n"],
    ["\\S+", "  ab  ", "ab"],
    ["\\bfoo\\b", "a foo b", "foo"],
    ["\\bfoo\\b", "afoob", null],
    ["\\Boo\\B", "afoob", "oo"],
    ["a\\nb", "a\nb", "a\nb"],
    ["a\\tb", "a\tb", "a\tb"],
    ["a\\\\b", "a\\b", "a\\b"],
    ["a\\.b", "a.b", "a.b"],
    ["a\\.b", "axb", null],
    ["\\u0041\\x42", "AB", "AB"],
    ["\\(x\\)", "(x)", "(x)"],
    ["cat|dog", "hotdog", "dog"],
    ["a|", "b", ""],
    ["(a|b)+c", "xabbac", "abbac"],
    ["(?:ab)+", "xababx", "abab"],
    ["a*", "baaa", ""],
    ["a+", "baaa", "aaa"],
    ["ba?", "bab", "ba"],
    ["a{2}", "aaaa", "aa"],
    ["a{2,}", "caaaa", "aaaa"],
    ["a{2,3}", "aaaa", "aaa"],
    ["a{0}b", "ab", "b"],
    ["a+?", "aaa", "a"],
    ["a*?b", "aaab", "aaab"],
    ["a{1,2}?", "aaa", "a"],
    ["<.+?>", "<a><b>", "<a>"],
    ["<.+>", "<a><b>", "<a><b>"],
    ["a{", "a{", "a{"],
    ["a{x}", "a{x}", "a{x}"],
    ["x{,3}", "x{,3}", "x{,3}"],
    ["a}", "a}", "a}"],
    ["^a", "ab", "a"],
    ["^a", "ba", null],
    ["^a", "b\na", null],
    ["a$", "ba", "a"],
    ["a$", "ab", null],
    ["a$", "a\nb", null],
    ["^$", "", ""],
    ["^$", "a", null],
    ["A", "a", null],
    ["(a|ab)(c|bcd)", "abcd", "abcd"],
    ["(a*)*", "aaa", "aaa"],
    ["(a*)+", "aaa", "aaa"],
    ["(a?)*b", "aab", "aab"],
  ])("%s on %j", (pattern, text, expected) => {
    expect(whole(pattern, text)).toBe(expected);
  });

  it("captures groups with unset ones empty", () => {
    expect(search("(a+)(b+)?", "xaac")).toEqual(["aa", "aa", ""]);
    expect(search("(\\w+)@(\\w+)", "me@host")).toEqual(["me@host", "me", "host"]);
    expect(search("(a)|(b)", "b")).toEqual(["b", "", "b"]);
    expect(search("((a)(b))", "ab")).toEqual(["ab", "ab", "a", "b"]);
    expect(search("(a)*", "aaa")).toEqual(["aaa", "a"]);
  });

  it("starts the search at the given offset", () => {
    expect(whole("a", "aXa")).toBe("a");
    const compiled = compileRegex("a");
    if (!compiled.ok) throw new Error("compile");
    const slots = execRegex(compiled.program, toCodePoints("aXa"), 1, quiet);
    expect(slots?.[0]).toBe(2);
  });

  it("matches code points, not UTF-16 units", () => {
    expect(whole("^.$", "\u{1F600}")).toBe("\u{1F600}");
    expect(whole("^..$", "\u{1F600}")).toBeNull();
    expect(whole("[\u{1F600}-\u{1F64F}]+", "a\u{1F601}\u{1F602}b")).toBe("\u{1F601}\u{1F602}");
  });
});

describe("unsupported syntax", () => {
  it.each([
    ["(?=a)", "lookahead is not supported"],
    ["(?!a)", "lookahead is not supported"],
    ["(?<=a)", "lookbehind is not supported"],
    ["(?<!a)", "lookbehind is not supported"],
    ["(?<name>a)", "named groups are not supported"],
    ["(a)\\1", "backreferences are not supported"],
    ["\\k<n>", "backreferences are not supported"],
    ["(?i)a", "group modifiers are not supported"],
    ["a**", "nothing to repeat"],
    ["*a", "nothing to repeat"],
    ["+", "nothing to repeat"],
    ["?", "nothing to repeat"],
    ["a|*", "nothing to repeat"],
    ["{2}", "nothing to repeat"],
    ["^*", "nothing to repeat"],
    ["\\b+", "nothing to repeat"],
    ["a{3,2}", "repeat range is out of order"],
    ["a{1001}", "repeat count is too large"],
    ["[z-a]", "character range is out of order"],
    ["[a", "missing ]"],
    ["(a", "missing )"],
    ["a)", "unmatched )"],
    ["\\", "trailing backslash"],
    ["\\q", "unknown escape \\q"],
    ["\\p{L}", "unknown escape \\p"],
    ["\\u12", "invalid escape"],
    ["\\xZZ", "invalid escape"],
    ["[\\B]", "invalid escape"],
  ])("rejects %s", (pattern, expected) => {
    expect(reason(pattern)).toBe(expected);
  });

  it("limits the compiled program to 5,000 instructions", () => {
    expect(reason("a{1000}")).toBeUndefined();
    expect(reason("a{1000}b{1000}c{1000}d{1000}e{1000}f{1000}")).toBe("pattern is too complex");
    expect(reason("((a{100}){100}){100}")).toBe("pattern is too complex");
    expect(reason("(a{0,1000}){0,5}")).toBe("pattern is too complex");
  });

  it("caches compiled patterns and survives eviction", () => {
    const first = compileRegex("cache-me");
    expect(compileRegex("cache-me")).toBe(first);
    for (let i = 0; i < 150; i += 1) compileRegex(`evict${i}`);
    expect(compileRegex("cache-me")).not.toBe(first);
    expect(whole("cache-me", "xcache-mex")).toBe("cache-me");
  });
});

describe("linear matching", () => {
  const count = (pattern: string, text: string): { instructions: number; matched: boolean } => {
    const compiled = compileRegex(pattern);
    if (!compiled.ok) throw new Error(compiled.reason);
    let instructions = 0;
    const slots = execRegex(compiled.program, toCodePoints(text), 0, {
      add: (n) => (instructions += n),
    });
    return { instructions, matched: slots !== null };
  };
  const a = "a".repeat(5000);

  it.each([
    ["(a+)+$", `${a}b`, false],
    ["(a*)*b", a, false],
    ["(a|aa)+$", `${a}b`, false],
    ["(a|a)*c", a, false],
    ["(x+x+)+y", "x".repeat(5000), false],
    ["^(a+)+$", `${a}!`, false],
    ["(.*a){12}", `${a}b`, true],
  ])("%s stays proportional to pattern times input", (pattern, text, expectedMatch) => {
    const { instructions, matched } = count(pattern, text);
    expect(matched).toBe(expectedMatch);
    expect(instructions).toBeLessThan(120 * (text.length + 1) * 2);
  });

  it("finishes inside the formula step budget and gives empty beyond it", () => {
    expect(ev('test(repeat("a", 5000) + "b", "(a+)+$")')).toBe(false);
    expect(ev('test(repeat("a", 5000) + "b", "(a+)+$")', {}, { maxSteps: 60 })).toBeNull();
  });

  it("matches a hit early without scanning the whole input", () => {
    const early = count("a", `a${"b".repeat(5000)}`);
    expect(early.matched).toBe(true);
    expect(early.instructions).toBeLessThan(50);
  });
});

describe("regex functions", () => {
  it.each([
    ['test("abc123", "\\\\d+")', true],
    ['test("abc", "\\\\d+")', false],
    ['test("", "")', true],
    ['test("ABC", "abc")', false],
    ['test("a\\nb", "^b")', false],
    ['match("a1b22c333", "\\\\d+")', ["1", "22", "333"]],
    ['match("abc", "x*")', ["", "", "", ""]],
    ['match("abc", "z")', []],
    ['match("aaa", "a")', ["a", "a", "a"]],
    ['match("\u{1F600}a\u{1F600}", ".")', ["\u{1F600}", "a", "\u{1F600}"]],
    ['replace("John Smith", "(\\\\w+) (\\\\w+)", "$2, $1")', "Smith, John"],
    ['replace("abc", "b", "[$&]")', "a[b]c"],
    ['replace("abc", "b", "$$")', "a$c"],
    ['replace("abc", "b", "$0")', "a$0c"],
    ['replace("abc", "b", "$3")', "a$3c"],
    ['replace("ac", "a(b)?c", "[$1]")', "[]"],
    ['replace("aaa", "a", "b")', "baa"],
    ['replace("abc", "z", "y")', "abc"],
    ['replaceAll("aaa", "a", "b")', "bbb"],
    ['replaceAll("a.b.c", "\\\\.", "")', "abc"],
    ['replaceAll("abc", "x*", "-")', "-a-b-c-"],
    ['replaceAll("\u{1F600}a\u{1F600}", "\u{1F600}", "x")', "xax"],
    ['replaceAll("a1b2", "(\\\\d)", "<$1>")', "a<1>b<2>"],
    ['replace(prop("Name"), "a", "b")', ""],
  ])("%s", (source, expected) => {
    expect(ev(source)).toEqual(expected);
  });

  it("gives empty for a computed pattern that is not supported", () => {
    const store = { row1: { t_name: "(" } };
    expect(ev('test("a", prop("Name"))', store)).toBeNull();
    expect(ev('match("a", prop("Name"))', store)).toBeNull();
    expect(ev('replace("a", prop("Name"), "b")', store)).toBeNull();
    expect(ev('replaceAll("a", prop("Name"), "b")', store)).toBeNull();
  });

  it("caps the size of what replaceAll builds", () => {
    expect(
      String(ev('replaceAll(repeat("a", 10000), "a", repeat("b", 100))')).length,
    ).toBeLessThanOrEqual(16_384);
  });
});
