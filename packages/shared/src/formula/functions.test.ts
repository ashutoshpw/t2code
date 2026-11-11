import { describe, expect, it } from "vite-plus/test";
import { FORMULA_VERSION, FUNCTIONS, compile, formatValue, type FormulaValue } from "./index.ts";
import { day, errors, ev, instant, makeSchema, page, type Store } from "./testkit.ts";

const row = (values: Record<string, FormulaValue>): Store => ({ row1: values });
type Case = readonly [title: string, source: string, expected: FormulaValue, store?: Store];

const run = (cases: ReadonlyArray<Case>): void => {
  it.each(cases.map(([title, source, expected, store]) => ({ title, source, expected, store })))(
    "$title",
    ({ source, expected, store }) => {
      expect(ev(source, store ?? {})).toEqual(expected);
    },
  );
};

const pages: Store = {
  row1: { t_project: [page("pA"), page("pB")], t_count: 3 },
  pA: { title: "Alpha", p_budget: 10, p_name: "Alpha", p_tasks: [page("tX", "tasks")] },
  pB: { title: "", p_budget: 5, p_name: null },
};

describe("logic", () => {
  run([
    ["if true", "if(true, 1, 2)", 1],
    ["if false", "if(false, 1, 2)", 2],
    ["if with a null condition is false", 'if(prop("Done"), 1, 2)', 2],
    ["if is lazy in its branches", "if(true, 1, 1 / 0)", 1],
    ["ternary", "false ? 1 : 2", 2],
    ["ifs takes the first true condition", "ifs(false, 1, true, 2, true, 3)", 2],
    ["ifs without a match and no fallback is empty", "ifs(false, 1, false, 2)", null],
    ["ifs fallback", 'ifs(false, "a", "z")', "z"],
    ["lets sees earlier bindings", "lets(a, 2, b, a * 3, a + b)", 8],
    ["let shadows an outer binding", "let(x, 1, let(x, x + 1, x))", 2],
    ["empty() is the empty value", "empty()", null],
    ["empty of null", 'empty(prop("Notes"))', true],
    ["empty of empty text", 'empty("")', true],
    ["empty of zero", "empty(0)", true],
    ["empty of false", "empty(false)", true],
    ["empty of empty list", "empty([])", true],
    ["empty of text", 'empty("a")', false],
    ["empty of a number", "empty(2)", false],
    ["empty of a list", "empty([1])", false],
    ["empty of a date", 'empty(parseDate("2024-01-01"))', false],
  ]);

  run([
    ["equal numbers", "1 == 1", true],
    ["unequal numbers", "1 != 1", false],
    ["text is case-sensitive", '"a" == "A"', false],
    ["null equals null", 'empty() == prop("Count")', true],
    ["null does not equal a value", 'prop("Count") == 0', false, row({ t_count: null })],
    ["a value does not equal null", 'prop("Count") == empty()', false, row({ t_count: 3 })],
    ["lists compare element-wise", "[1, 2] == [1, 2]", true],
    ["lists compare by length", "[1] == [1, 2]", false],
    ["lists compare by order", "[1, 2] == [2, 1]", false],
    ["nested lists", "[[1], [2]] == [[1], [2]]", true],
    ["rich text equals its plain text", 'style("a", "b") == "a"', true],
    ["pages compare by id", 'prop("Project").first() == prop("Project").first()', true, pages],
    ["different pages differ", 'prop("Project").first() != prop("Project").last()', true, pages],
    ["booleans", "true == false", false],
    ["unequal function", "unequal(1, 2)", true],
    ["equal function", 'equal("a", "a")', true],
  ]);

  run([
    ["and", "and(true, false)", false],
    ["and of three", "and(true, true, true)", true],
    ["or", "or(false, true)", true],
    ["or of all false", "or(false, false)", false],
    ["not", "not(true)", false],
    ["a null boolean is false", 'not(prop("Done"))', true],
    ["null and true", 'prop("Done") and true', false],
    ["null or true", 'prop("Done") || true', true],
    ["and short-circuits past a failing right side", "false and (1 / 0 > 0)", false],
    ["or short-circuits", "true or (1 / 0 > 0)", true],
  ]);

  run([
    ["less than", "1 < 2", true],
    ["less or equal", "2 <= 2", true],
    ["greater than", "1 > 2", false],
    ["greater or equal", "2 >= 3", false],
    ["text order by code point", '"B" < "a"', true],
    ["text order, astral after BMP", '"\u{1F600}" > "～"', true],
    ["booleans order false before true", "false < true", true],
    ["dates order", 'parseDate("2024-01-01") < parseDate("2024-01-02")', true],
    ["a null operand gives false (<)", 'prop("Count") < 5', false],
    ["a null operand gives false (>=)", 'prop("Count") >= 0', false],
    ["a null operand gives false on the left of text", 'prop("Notes") < "a"', false],
    ["larger function", "larger(2, 1)", true],
  ]);

  run([
    ["id of this row", "id()", "row1"],
    ["id of a page", 'id(prop("Project").first())', "pA", pages],
    ["id of an empty relation", 'id(prop("Project").first())', null],
  ]);
});

describe("text", () => {
  run([
    ["length of text", 'length("hello")', 5],
    ["length counts code points", 'length("\u{1F600}a")', 2],
    ["length of empty text", 'length("")', 0],
    ["length of null text", 'length(prop("Name"))', 0],
    ["length of a list", "length([1, 2, 3])", 3],
    ["length of a null list", 'length(prop("Tags"))', 0],
    ["substring with an end", 'substring("hello", 1, 3)', "el"],
    ["substring without an end", 'substring("hello", 2)', "llo"],
    ["substring clamps a negative start", 'substring("hello", -5, 2)', "he"],
    ["substring swaps start and end", 'substring("hello", 3, 1)', "el"],
    ["substring past the end", 'substring("hello", 10)', ""],
    ["substring by code point", 'substring("\u{1F600}\u{1F601}\u{1F602}", 1, 2)', "\u{1F601}"],
    ["substring with a null start is empty", 'substring("hello", prop("Count"))', null],
    ["substring of null text", 'substring(prop("Name"), 0, 2)', ""],
    ["contains", 'contains("hello", "ell")', true],
    ["contains is case-sensitive", 'contains("hello", "ELL")', false],
    ["contains the empty text", 'contains("hello", "")', true],
    ["contains in null text", 'contains(prop("Name"), "a")', false],
    ["lower", 'lower("HeLLo")', "hello"],
    ["upper", 'upper("HeLLo")', "HELLO"],
    ["upper of null", 'upper(prop("Name"))', ""],
    ["upper is locale independent", 'upper("i")', "I"],
    ["trim", 'trim("  hi \n")', "hi"],
    ["trim nothing", 'trim("")', ""],
    ["repeat", 'repeat("ab", 3)', "ababab"],
    ["repeat zero", 'repeat("ab", 0)', ""],
    ["repeat negative", 'repeat("ab", -2)', ""],
    ["repeat floors the count", 'repeat("ab", 2.9)', "abab"],
    ["repeat empty text", 'repeat("", 5)', ""],
    ["padStart", 'padStart("7", 3, "0")', "007"],
    ["padStart when already long", 'padStart("abcd", 3, "0")', "abcd"],
    ["padStart with an empty pad", 'padStart("a", 3, "")', "a"],
    ["padEnd with a multi-character pad", 'padEnd("a", 4, "xy")', "axyx"],
    ["padEnd counts code points", 'padEnd("\u{1F600}", 2, "-")', "\u{1F600}-"],
  ]);

  it("caps text at 16,384 characters", () => {
    expect(String(ev('repeat("abcdefgh", 100000)')).length).toBe(16_384);
    expect(String(ev('padStart("a", 99999, "z")')).length).toBe(16_384);
    expect(String(ev('repeat("\u{1F600}", 100000)')).length % 2).toBe(0);
  });

  run([
    [
      "link",
      'link("Docs", "https://x.test")',
      { kind: "rich", runs: [{ text: "Docs", link: "https://x.test" }] },
    ],
    ["link with an empty url is plain", 'link("Docs", "")', "Docs"],
    ["style bold", 'style("a", "b")', { kind: "rich", runs: [{ text: "a", bold: true }] }],
    [
      "style several",
      'style("a", "b", "i", "red", "blue_background")',
      {
        kind: "rich",
        runs: [{ text: "a", bold: true, italic: true, color: "red", background: "blue" }],
      },
    ],
    [
      "style code underline strike",
      'style("a", "c", "u", "s")',
      { kind: "rich", runs: [{ text: "a", code: true, underline: true, strike: true }] },
    ],
    [
      "style adds to rich text",
      'style(style("a", "b"), "i")',
      { kind: "rich", runs: [{ text: "a", bold: true, italic: true }] },
    ],
    [
      "unstyle one",
      'unstyle(style("a", "b", "i"), "b")',
      { kind: "rich", runs: [{ text: "a", italic: true }] },
    ],
    ["unstyle all", 'unstyle(style("a", "b", "i"))', "a"],
    ["unstyle the last style gives plain text", 'unstyle(style("a", "b"), "b")', "a"],
    ["unstyle a color", 'unstyle(style("a", "red"), "red")', "a"],
    [
      "a computed unknown style is ignored",
      'style("a", "b", prop("Notes"))',
      { kind: "rich", runs: [{ text: "a", bold: true }] },
    ],
    ["plain text functions read rich text", 'upper(style("ab", "b"))', "AB"],
    ["rich text length", 'length(style("ab", "b"))', 2],
  ]);

  run([
    [
      "rich text joins keep runs",
      'style("a", "b") + "c"',
      { kind: "rich", runs: [{ text: "a", bold: true }, { text: "c" }] },
    ],
    ["plain parts merge", '"a" + "b" + "c"', "abc"],
    ["number joins text", '"a" + 1', "a1"],
    ["text joins a number on the left", '1 + "a"', "1a"],
    ["text joins a boolean", '"a" + true', "atrue"],
    ["text joins a date", '"d: " + parseDate("2024-03-15")', "d: March 15, 2024"],
    ["text joins a list", '"l: " + [1, 2]', "l: 1, 2"],
    ["two null texts give null", 'prop("Notes") + prop("Name")', null],
    ["a null text joins as empty", 'prop("Notes") + "x"', "x"],
    ["a null number joins text as empty", '"x" + prop("Count")', "x"],
    ["page titles join", '"p: " + prop("Project").first()', "p: Alpha", pages],
    ["add function joins text", 'add("a", "b")', "ab"],
  ]);

  run([
    ["format number", "format(1.5)", "1.5"],
    ["format integer", "format(10)", "10"],
    ["format boolean", "format(true)", "true"],
    ["format empty", "format(empty())", ""],
    ["format null text", 'format(prop("Notes"))', ""],
    ["format date-only", 'format(parseDate("2024-03-15"))', "March 15, 2024"],
    ["format timed date", 'format(parseDate("2024-03-15T13:05"))', "March 15, 2024 1:05 PM"],
    [
      "format a range",
      'format(dateRange(parseDate("2024-03-15"), parseDate("2024-03-17")))',
      "March 15, 2024 → March 17, 2024",
    ],
    ["format list", "format([1, 2, 3])", "1, 2, 3"],
    ["format page uses its title", 'format(prop("Project").first())', "Alpha", pages],
    ["format an untitled page", 'format(prop("Project").last())', "Untitled", pages],
    [
      "format an unknown page",
      'format(prop("Project").first())',
      "",
      { row1: { t_project: [page("zz")] } },
    ],
    ["format rich text", 'format(style("a", "b"))', "a"],
    ["format very small number", "format(0.000001)", "0.000001"],
  ]);

  run([
    ["split with the default separator", 'split("a,b,c")', ["a", "b", "c"]],
    ["split with a separator", 'split("a-b", "-")', ["a", "b"]],
    ["split is not a regex", 'split("a.b", ".")', ["a", "b"]],
    ["split into code points", 'split("\u{1F600}a", "")', ["\u{1F600}", "a"]],
    ["split empty text", 'split("")', []],
    ["split null text", 'split(prop("Name"))', []],
    ["split keeps empty parts", 'split("a,,b")', ["a", "", "b"]],
    ["join default", 'join(["a", "b"])', "a,b"],
    ["join with a separator", 'join(["a", "b"], " - ")', "a - b"],
    ["join empty list", "join([])", ""],
    ["join numbers", "join([1, 2])", "1,2"],
    ["join null list", 'join(prop("Tags"))', ""],
    ["join pages by title", 'join(prop("Project"), "; ")', "Alpha; Untitled", pages],
  ]);

  it("caps lists at 1,000 items", () => {
    expect((ev('split(repeat("a,", 2000))') as unknown[]).length).toBe(1000);
  });

  run([
    ["toNumber of text with commas", 'toNumber("1,200.5")', 1200.5],
    ["toNumber trims", 'toNumber(" 42 ")', 42],
    ["toNumber exponent", 'toNumber("1e3")', 1000],
    ["toNumber signs", 'toNumber("-5") + toNumber("+5")', 0],
    ["toNumber leading dot", 'toNumber(".5")', 0.5],
    ["toNumber trailing dot", 'toNumber("5.")', 5],
    ["toNumber of junk", 'toNumber("abc")', null],
    ["toNumber of a unit suffix", 'toNumber("5px")', null],
    ["toNumber of empty text", 'toNumber("")', null],
    ["toNumber of a number", "toNumber(3)", 3],
    ["toNumber of true", "toNumber(true)", 1],
    ["toNumber of false", "toNumber(false)", 0],
    ["toNumber of a date", 'toNumber(parseDate("1970-01-02"))', 86_400_000],
    ["toNumber of null", 'toNumber(prop("Notes"))', null],
    ["toNumber of a list", "toNumber([1])", null],
  ]);

  run([
    ["formatNumber default", "formatNumber(3.7)", "4"],
    ["formatNumber decimals", 'formatNumber(3.14159, "number", 2)', "3.14"],
    ["formatNumber commas", 'formatNumber(1234.5, "commas")', "1,235"],
    ["formatNumber commas with decimals", 'formatNumber(1234567.891, "commas", 1)', "1,234,567.9"],
    ["formatNumber dollar", 'formatNumber(1234.5, "dollar")', "$1,234.50"],
    ["formatNumber euro negative", 'formatNumber(-5, "euro")', "-€5.00"],
    ["formatNumber yen has no decimals", 'formatNumber(1500, "yen")', "¥1,500"],
    ["formatNumber rupee", 'formatNumber(99.5, "rupee")', "₹99.50"],
    ["formatNumber percent", 'formatNumber(0.256, "percent")', "26%"],
    ["formatNumber percent with decimals", 'formatNumber(0.256, "percent", 1)', "25.6%"],
    ["formatNumber rounds half away from zero", 'formatNumber(2.675, "number", 2)', "2.68"],
    ["formatNumber negative half", 'formatNumber(-2.5, "number")', "-3"],
    ["formatNumber clamps decimals", 'formatNumber(1.5, "number", 99)', "1.5000000000"],
    ["formatNumber unknown format", 'formatNumber(1, "bitcoin")', null],
    ["formatNumber of null", 'formatNumber(prop("Count"))', null],
    ["formatNumber negative zero", 'formatNumber(-0.001, "number", 1)', "0.0"],
  ]);
});

describe("number", () => {
  run([
    ["null operands give null (+)", 'prop("Count") + 1', null],
    ["null operands give null (*)", 'prop("Count") * 2', null],
    ["null operands give null (unary -)", '-prop("Count")', null],
    ["division by zero is empty", "1 / 0", null],
    ["modulo by zero is empty", "5 % 0", null],
    ["mod keeps the sign of the dividend", "-7 % 3", -1],
    ["mod with a negative divisor", "7 % -3", 1],
    ["mod", "7 % 3", 1],
    ["pow", "2 ^ 10", 1024],
    ["zero to the zero", "0 ^ 0", 1],
    ["root of a negative is empty", "(-8) ^ (1 / 3)", null],
    ["overflow is empty", "2 ^ 5000", null],
    ["floating sums stay exact enough", "0.5 + 0.25", 0.75],
    ["negative zero becomes zero", "0 * -1", 0],
    ["division", "7 / 2", 3.5],
    ["subtract", "5 - 8", -3],
    ["multiply function", "multiply(3, 4)", 12],
    ["pow function", "pow(3, 2)", 9],
    ["unary minus on a value", "let(x, 4, -x)", -4],
    ["add with an empty() operand", "1 + empty()", null],
  ]);

  run([
    ["sum", "sum(1, 2, 3)", 6],
    ["sum of lists and numbers", "sum([1, 2], 3)", 6],
    ["sum of an empty list is zero", "sum([])", 0],
    ["sum skips null", 'sum(prop("Count"), 2)', 2],
    ["min", "min(3, 1, 2)", 1],
    ["min of nothing is empty", "min([])", null],
    ["max", "max([3, 9], 4)", 9],
    ["max skips null", 'max(prop("Count"), 3)', 3],
    ["mean", "mean([1, 2, 3, 4])", 2.5],
    ["mean of nothing is empty", "mean([])", null],
    ["median odd", "median([3, 1, 2])", 2],
    ["median even", "median([1, 2, 3, 4])", 2.5],
    ["median of nothing is empty", "median([])", null],
    ["abs", "abs(-3)", 3],
    ["abs of null", 'abs(prop("Count"))', null],
    ["ceil", "ceil(1.2)", 2],
    ["ceil negative", "ceil(-1.2)", -1],
    ["floor", "floor(1.8)", 1],
    ["floor negative", "floor(-1.2)", -2],
    ["sqrt", "sqrt(16)", 4],
    ["sqrt of a negative is empty", "sqrt(-1)", null],
    ["cbrt", "cbrt(-27)", -3],
    ["exp", "exp(0)", 1],
    ["ln", "ln(1)", 0],
    ["ln of zero is empty", "ln(0)", null],
    ["ln of a negative is empty", "ln(-1)", null],
    ["log10", "log10(1000)", 3],
    ["log2", "log2(8)", 3],
    ["log of zero is empty", "log10(0)", null],
    ["sign negative", "sign(-5)", -1],
    ["sign zero", "sign(0)", 0],
    ["sign positive", "sign(9)", 1],
    ["pi", "pi()", Math.PI],
    ["e", "e()", Math.E],
    ["ln of e", "ln(e())", 1],
  ]);

  run([
    ["round half up", "round(2.5)", 3],
    ["round half away from zero", "round(-2.5)", -3],
    ["round down", "round(2.4)", 2],
    ["round places", "round(2.675, 2)", 2.68],
    ["round places 1.005", "round(1.005, 2)", 1.01],
    ["round with negative places clamps to zero", "round(1234.5678, -1)", 1235],
    ["round clamps places to ten", "round(1.23456789012345, 15)", 1.2345678901],
    ["round of null", 'round(prop("Count"))', null],
    ["round half", "round(0.5)", 1],
    ["round a large value", "round(1e21 + 0.5)", 1e21],
    ["round zero places explicit", "round(7.5, 0)", 8],
  ]);
});

describe("list", () => {
  run([
    ["at", "at([1, 2, 3], 0)", 1],
    ["at from the end", "at([1, 2, 3], -1)", 3],
    ["at out of range", "at([1, 2, 3], 5)", null],
    ["at out of range from the end", "at([1, 2, 3], -5)", null],
    ["at truncates the index", "at([1, 2, 3], 1.9)", 2],
    ["at of a null list", 'at(prop("Tags"), 0)', null],
    ["first", "first([1, 2])", 1],
    ["first of empty", "first([])", null],
    ["last", "last([1, 2])", 2],
    ["last of empty", "last([])", null],
    ["slice", "slice([1, 2, 3, 4], 1, 3)", [2, 3]],
    ["slice from the end", "slice([1, 2, 3, 4], -2)", [3, 4]],
    ["slice without an end", "slice([1, 2, 3], 1)", [2, 3]],
    ["slice past the end", "slice([1, 2], 5)", []],
    ["concat", "concat([1], [2, 3])", [1, 2, 3]],
    ["concat appends a non-list", "concat([1], 2)", [1, 2]],
    ["concat skips empty values", "concat([1], empty())", [1]],
    ["concat with a null list", 'concat(prop("Tags"), ["a"])', ["a"]],
    ["concat of three", "concat([1], [2], [3])", [1, 2, 3]],
    ["reverse", "reverse([1, 2, 3])", [3, 2, 1]],
    ["reverse empty", "reverse([])", []],
    ["unique", "unique([1, 1, 2, 1])", [1, 2]],
    ["unique is case-sensitive", 'unique(["a", "A", "a"])', ["a", "A"]],
    ["unique nested lists", "unique([[1], [1], [2]])", [[1], [2]]],
    ["unique of empties", "unique([empty(), empty()])", [null]],
    [
      "unique pages",
      'unique(concat(prop("Project"), prop("Project")))',
      [page("pA"), page("pB")],
      pages,
    ],
    ["includes", "includes([1, 2], 2)", true],
    ["includes miss", 'includes(["a"], "b")', false],
    ["includes empty", "includes([empty()], empty())", true],
    ["includes in a null list", 'includes(prop("Tags"), "a")', false],
    ["includes a page", 'includes(prop("Project"), prop("Project").last())', true, pages],
    ["flat", "flat([[1], [2, 3]])", [1, 2, 3]],
    ["flat keeps non-lists", "flat([1, [2]])", [1, 2]],
    ["flat empty", "flat([])", []],
  ]);

  run([
    ["map", "[1, 2, 3].map(current * 2)", [2, 4, 6]],
    ["map with index", "[10, 20, 30].map(current + index)", [10, 21, 32]],
    [
      "map nested shadows current and index",
      "[[1, 2], [3]].map(current.map(current * index))",
      [[0, 2], [0]],
    ],
    ["map over a null list", 'prop("Tags").map(upper(current))', []],
    ["map reads related pages", 'prop("Project").map(current.prop("Budget"))', [10, 5], pages],
    ["map sums related values", 'sum(prop("Project").map(current.prop("Budget")))', 15, pages],
    [
      "map a related relation",
      'prop("Project").map(current.prop("Tasks").length())',
      [1, 0],
      pages,
    ],
    ["filter", "[1, 2, 3].filter(current > 1)", [2, 3]],
    ["filter with index", "[5, 6, 7].filter(index > 0)", [6, 7]],
    ["find", "[1, 2, 3].find(current > 1)", 2],
    ["find none", "[1, 2, 3].find(current > 5)", null],
    ["findIndex", "[1, 2, 3].findIndex(current > 1)", 1],
    ["findIndex none", "[1, 2, 3].findIndex(current > 5)", -1],
    ["some", "[1, 2, 3].some(current > 2)", true],
    ["some of empty", "[].some(true)", false],
    ["every", "[1, 2, 3].every(current > 0)", true],
    ["every miss", "[1, 2, 3].every(current > 1)", false],
    ["every of empty", "[].every(false)", true],
    ["a null test result is false", "[1].filter(empty() == 1)", []],
    ["lambda closes over let", "let(n, 10, [1, 2].map(current + n))", [11, 12]],
    [
      "lambda sees the row",
      'prop("Tags").map(current + prop("Name"))',
      ["ab", "bb"],
      row({ t_tags: ["a", "b"], t_name: "b" }),
    ],
  ]);

  run([
    ["sort numbers", "sort([3, 1, 2])", [1, 2, 3]],
    ["sort text by code point", 'sort(["b", "B", "a"])', ["B", "a", "b"]],
    ["sort puts empty last", "sort([2, empty(), 1])", [1, 2, null]],
    [
      "sort by a key is stable",
      'sort(["bb", "a", "cc", "d"], length(current))',
      ["a", "d", "bb", "cc"],
    ],
    ["sort by index reverses nothing", "sort([3, 1], index)", [3, 1]],
    ["sort mixed kinds", 'sort([true, "a", 1])', [1, "a", true]],
    ["sort booleans", "sort([true, false, true])", [false, true, true]],
    [
      "sort dates",
      'sort([parseDate("2024-03-02"), parseDate("2024-03-01")])',
      [day(2024, 3, 1), day(2024, 3, 2)],
    ],
    ["sort pages by id", 'sort(prop("Project").reverse())', [page("pA"), page("pB")], pages],
    [
      "sort by a related key",
      'prop("Project").sort(current.prop("Budget")).map(current.prop("Budget"))',
      [5, 10],
      pages,
    ],
    ["sort empty", "sort([])", []],
  ]);

  it("caps lists produced by concat and map at 1,000 items", () => {
    const big = `split(repeat("a,", 700)).concat(split(repeat("b,", 700)))`;
    expect((ev(big) as unknown[]).length).toBe(1000);
    expect((ev(`${big}.map(current)`) as unknown[]).length).toBe(1000);
  });
});

describe("any-typed operands", () => {
  const s = makeSchema([{ id: "t_loose", name: "Loose", type: "any" }]);
  const loose = (source: string, value: FormulaValue) => ev(source, row({ t_loose: value }), {}, s);
  it("decides + by the runtime values", () => {
    expect(loose('prop("Loose") + 1', 2)).toBe(3);
    expect(loose('prop("Loose") + 1', "a")).toBe("a1");
    expect(loose('prop("Loose") + prop("Loose")', null)).toBeNull();
    expect(loose('prop("Loose") + 1', null)).toBeNull();
    expect(loose('prop("Loose") + 1', [1])).toBeNull();
  });
  it("gives empty for arguments of the wrong runtime type", () => {
    expect(loose('upper(prop("Loose"))', 5)).toBeNull();
    expect(loose('abs(prop("Loose"))', "x")).toBeNull();
    expect(loose('if(prop("Loose"), 1, 2)', "x")).toBe(2);
  });
});

describe("reference", () => {
  it("lists every function of the language once with a signature, description and example", () => {
    const names = FUNCTIONS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    for (const f of FUNCTIONS) {
      expect(f.signature.startsWith(f.name)).toBe(true);
      expect(f.description).not.toBe("");
      expect(f.example).not.toBe("");
    }
    for (const required of [
      "if",
      "ifs",
      "let",
      "lets",
      "empty",
      "equal",
      "unequal",
      "and",
      "or",
      "not",
      "length",
      "substring",
      "contains",
      "test",
      "match",
      "replace",
      "replaceAll",
      "lower",
      "upper",
      "trim",
      "repeat",
      "padStart",
      "padEnd",
      "link",
      "style",
      "unstyle",
      "format",
      "split",
      "join",
      "toNumber",
      "formatNumber",
      "add",
      "subtract",
      "multiply",
      "divide",
      "mod",
      "pow",
      "min",
      "max",
      "sum",
      "mean",
      "median",
      "abs",
      "ceil",
      "floor",
      "sqrt",
      "cbrt",
      "exp",
      "ln",
      "log10",
      "log2",
      "sign",
      "round",
      "pi",
      "e",
      "now",
      "today",
      "parseDate",
      "timestamp",
      "fromTimestamp",
      "formatDate",
      "minute",
      "hour",
      "date",
      "day",
      "week",
      "month",
      "year",
      "dateAdd",
      "dateSubtract",
      "dateBetween",
      "dateRange",
      "dateStart",
      "dateEnd",
      "at",
      "first",
      "last",
      "slice",
      "concat",
      "sort",
      "reverse",
      "unique",
      "includes",
      "find",
      "findIndex",
      "filter",
      "some",
      "every",
      "map",
      "flat",
      "id",
    ]) {
      expect(names).toContain(required);
    }
    expect(names).not.toContain("addText");
    expect(names).not.toContain("name");
  });

  it("compiles every documented example", () => {
    const s = makeSchema([
      { id: "t_dates", name: "Dates", type: "date" },
      { id: "t_start", name: "Start", type: "date" },
      { id: "t_end", name: "End", type: "date" },
    ]);
    for (const f of FUNCTIONS) {
      expect(compile(f.example, s).diagnostics, f.example).toEqual([]);
    }
  });
});

describe("dot chaining", () => {
  it.each([
    ['"abc".upper()', 'upper("abc")'],
    ['"a-b".split("-").join("+")', 'join(split("a-b", "-"), "+")'],
    ["[3, 1, 2].sort().first()", "first(sort([3, 1, 2]))"],
    ["[1, 2, 3].map(current * 2).sum()", "sum(map([1, 2, 3], current * 2))"],
    ['"abc".substring(1)', 'substring("abc", 1)'],
    ["(4).sqrt()", "sqrt(4)"],
    [
      'parseDate("2024-01-31").dateAdd(1, "months").month()',
      'month(dateAdd(parseDate("2024-01-31"), 1, "months"))',
    ],
    ["true.not()", "not(true)"],
    ['"a".add("b")', 'add("a", "b")'],
    ["[1, 2].includes(2)", "includes([1, 2], 2)"],
    ["[[1], [2]].flat().length", "length(flat([[1], [2]]))"],
  ])("%s equals %s", (chained, plain) => {
    expect(ev(chained)).toEqual(ev(plain));
  });

  it("types and fails the same way", () => {
    expect(errors('"abc".upper(1)')).toEqual(errors('upper("abc", 1)'));
    expect(errors("1.upper()")).toEqual(errors("upper(1)"));
  });
});

describe("formatValue and version", () => {
  const ctx = { timeZone: "UTC", titleOf: (id: string) => (id === "p" ? "Page" : undefined) };
  it("formats every value kind", () => {
    expect(formatValue(null, ctx)).toBe("");
    expect(formatValue(1.5, ctx)).toBe("1.5");
    expect(formatValue(false, ctx)).toBe("false");
    expect(formatValue([1, [2, 3]], ctx)).toBe("1, 2, 3");
    expect(formatValue(page("p"), ctx)).toBe("Page");
    expect(formatValue(page("q"), ctx)).toBe("");
    expect(formatValue(day(2024, 3, 15), ctx)).toBe("March 15, 2024");
    expect(
      formatValue(instant(Date.UTC(2024, 2, 15, 13, 5)), { ...ctx, timeZone: "America/New_York" }),
    ).toBe("March 15, 2024 9:05 AM");
    expect(formatValue(instant(0), { ...ctx, timeZone: "Not/AZone" })).toBe(
      "January 1, 1970 12:00 AM",
    );
  });
  it("is version 1", () => {
    expect(FORMULA_VERSION).toBe(1);
  });
});
