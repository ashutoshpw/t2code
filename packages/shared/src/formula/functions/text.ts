import { type FnDef, asList, asNum, asStr } from "../fn.ts";
import { formatNumber, parseNumberText } from "../numbers.ts";
import { compileRegex, execRegex, toCodePoints, type RegexProgram } from "../regex.ts";
import type { Runtime } from "../runtime.ts";
import {
  type FormulaValue,
  type RichText,
  type Run,
  MAX_LIST,
  MAX_TEXT,
  capList,
  capText,
  formatValue,
  isDateValue,
  isRich,
  instantOf,
  plainText,
  richOrPlain,
  runsOf,
} from "../values.ts";

const COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const FLAGS = ["b", "i", "u", "s", "c"];

const isStyleName = (name: string): boolean =>
  FLAGS.includes(name) ||
  COLORS.includes(name) ||
  (name.endsWith("_background") && COLORS.includes(name.slice(0, -"_background".length)));

function applyStyle(run: Run, name: string): Run {
  switch (name) {
    case "b":
      return { ...run, bold: true };
    case "i":
      return { ...run, italic: true };
    case "u":
      return { ...run, underline: true };
    case "s":
      return { ...run, strike: true };
    case "c":
      return { ...run, code: true };
    default:
      if (COLORS.includes(name)) return { ...run, color: name };
      if (name.endsWith("_background"))
        return { ...run, background: name.slice(0, -"_background".length) };
      return run;
  }
}

function removeStyle(run: Run, name: string): Run {
  const { bold, italic, underline, strike, code, color, background, ...rest } = run;
  const keep = {
    ...(bold === true && name !== "b" ? { bold } : {}),
    ...(italic === true && name !== "i" ? { italic } : {}),
    ...(underline === true && name !== "u" ? { underline } : {}),
    ...(strike === true && name !== "s" ? { strike } : {}),
    ...(code === true && name !== "c" ? { code } : {}),
    ...(color !== undefined && color !== name ? { color } : {}),
    ...(background !== undefined && `${background}_background` !== name ? { background } : {}),
  };
  return { ...rest, ...keep };
}

const richArg = (v: FormulaValue | undefined): string | RichText => {
  const value = v ?? null;
  return isRich(value) ? value : asStr(value);
};

const metered = (rt: Runtime) => ({ add: (n: number) => rt.work(n) });

function withRegex<T>(
  pattern: string,
  rt: Runtime,
  use: (
    program: RegexProgram,
    run: (cps: number[], from: number) => ReadonlyArray<number> | null,
  ) => T,
): T | null {
  const compiled = compileRegex(pattern);
  if (!compiled.ok) return null;
  const meter = metered(rt);
  return use(compiled.program, (cps, from) => execRegex(compiled.program, cps, from, meter));
}

const str = (cps: ReadonlyArray<number>, a: number, b: number): string =>
  String.fromCodePoint(...cps.slice(a, b));

function expand(
  replacement: string,
  cps: ReadonlyArray<number>,
  slots: ReadonlyArray<number>,
): string {
  let out = "";
  for (let i = 0; i < replacement.length; i += 1) {
    const ch = replacement[i] ?? "";
    const next = replacement[i + 1] ?? "";
    if (ch !== "$") {
      out += ch;
      continue;
    }
    if (next === "$") {
      out += "$";
      i += 1;
    } else if (next === "&") {
      out += str(cps, slots[0] ?? 0, slots[1] ?? 0);
      i += 1;
    } else if (next >= "1" && next <= "9") {
      const g = Number(next);
      if (g * 2 + 1 < slots.length) {
        const a = slots[g * 2] ?? -1;
        const b = slots[g * 2 + 1] ?? -1;
        if (a >= 0 && b >= 0) out += str(cps, a, b);
        i += 1;
      } else out += "$";
    } else out += "$";
  }
  return out;
}

function replaceMatches(
  text: string,
  pattern: string,
  replacement: string,
  all: boolean,
  rt: Runtime,
): FormulaValue {
  return withRegex(pattern, rt, (_program, run) => {
    const cps = toCodePoints(text);
    let out = "";
    let last = 0;
    let from = 0;
    while (from <= cps.length) {
      rt.tick();
      const slots = run(cps, from);
      if (slots === null) break;
      const start = slots[0] ?? 0;
      const end = slots[1] ?? 0;
      out += str(cps, last, start) + expand(replacement, cps, slots);
      last = end;
      from = end === start ? end + 1 : end;
      if (!all || out.length > MAX_TEXT) break;
    }
    return capText(out + str(cps, last, cps.length));
  });
}

const sub = (cps: ReadonlyArray<number>, start: number, end: number): string =>
  str(cps, start, end);

export const textFunctions: ReadonlyArray<FnDef> = [
  {
    name: "length",
    signature: "length(text or list)",
    description: "The number of characters in text, or items in a list.",
    example: 'length("hello")',
    category: "text",
    params: ["textList"],
    min: 1,
    max: 1,
    ret: "number",
    run: ([v]) => {
      const t = plainText(v ?? null);
      if (t !== null) return toCodePoints(t).length;
      return Array.isArray(v) ? v.length : 0;
    },
  },
  {
    name: "substring",
    signature: "substring(text, start, end?)",
    description: "Part of the text from start up to, but not including, end.",
    example: 'substring("hello", 1, 3)',
    category: "text",
    params: ["text", "number", "number"],
    min: 2,
    max: 3,
    ret: "text",
    run: ([t, a, b]) => {
      const cps = toCodePoints(asStr(t));
      const n = cps.length;
      const clamp = (x: number): number => Math.min(n, Math.max(0, Math.trunc(x)));
      let s = clamp(asNum(a));
      let e = typeof b === "number" ? clamp(b) : n;
      if (s > e) [s, e] = [e, s];
      return sub(cps, s, e);
    },
  },
  {
    name: "contains",
    signature: "contains(text, search)",
    description: "Whether the text contains the search text. Case-sensitive.",
    example: 'contains("hello", "ell")',
    category: "text",
    params: ["text", "text"],
    min: 2,
    max: 2,
    ret: "boolean",
    run: ([t, s]) => asStr(t).includes(asStr(s)),
  },
  {
    name: "test",
    signature: "test(text, pattern)",
    description: "Whether the pattern matches anywhere in the text.",
    example: 'test("abc123", "\\\\d+")',
    category: "text",
    params: ["text", "text"],
    min: 2,
    max: 2,
    ret: "boolean",
    literal: (i, v) => (i === 1 ? regexProblem(v) : undefined),
    run: ([t, p], rt) =>
      withRegex(asStr(p), rt, (_prog, run) => run(toCodePoints(asStr(t)), 0) !== null),
  },
  {
    name: "match",
    signature: "match(text, pattern)",
    description: "Every non-overlapping match of the pattern, as a list.",
    example: 'match("a1b22", "\\\\d+")',
    category: "text",
    params: ["text", "text"],
    min: 2,
    max: 2,
    ret: { list: "text" },
    literal: (i, v) => (i === 1 ? regexProblem(v) : undefined),
    run: ([t, p], rt) =>
      withRegex(asStr(p), rt, (_prog, run) => {
        const cps = toCodePoints(asStr(t));
        const out: FormulaValue[] = [];
        let from = 0;
        while (from <= cps.length && out.length < MAX_LIST) {
          rt.tick();
          const slots = run(cps, from);
          if (slots === null) break;
          const start = slots[0] ?? 0;
          const end = slots[1] ?? 0;
          out.push(str(cps, start, end));
          from = end === start ? end + 1 : end;
        }
        return out;
      }),
  },
  {
    name: "replace",
    signature: "replace(text, pattern, replacement)",
    description: "Replaces the first match of the pattern. $1 to $9 and $& insert matches.",
    example: 'replace("hello", "l+", "L")',
    category: "text",
    params: ["text", "text", "text"],
    min: 3,
    max: 3,
    ret: "text",
    literal: (i, v) => (i === 1 ? regexProblem(v) : undefined),
    run: ([t, p, r], rt) => replaceMatches(asStr(t), asStr(p), asStr(r), false, rt),
  },
  {
    name: "replaceAll",
    signature: "replaceAll(text, pattern, replacement)",
    description: "Replaces every match of the pattern.",
    example: 'replaceAll("a-b-c", "-", "+")',
    category: "text",
    params: ["text", "text", "text"],
    min: 3,
    max: 3,
    ret: "text",
    literal: (i, v) => (i === 1 ? regexProblem(v) : undefined),
    run: ([t, p, r], rt) => replaceMatches(asStr(t), asStr(p), asStr(r), true, rt),
  },
  {
    name: "lower",
    signature: "lower(text)",
    description: "The text in lower case.",
    example: 'lower("Hello")',
    category: "text",
    params: ["text"],
    min: 1,
    max: 1,
    ret: "text",
    run: ([t]) => asStr(t).toLowerCase(),
  },
  {
    name: "upper",
    signature: "upper(text)",
    description: "The text in upper case.",
    example: 'upper("Hello")',
    category: "text",
    params: ["text"],
    min: 1,
    max: 1,
    ret: "text",
    run: ([t]) => asStr(t).toUpperCase(),
  },
  {
    name: "trim",
    signature: "trim(text)",
    description: "The text without leading and trailing whitespace.",
    example: 'trim("  hi ")',
    category: "text",
    params: ["text"],
    min: 1,
    max: 1,
    ret: "text",
    run: ([t]) => asStr(t).trim(),
  },
  {
    name: "repeat",
    signature: "repeat(text, count)",
    description: "The text repeated count times.",
    example: 'repeat("ab", 3)',
    category: "text",
    params: ["text", "number"],
    min: 2,
    max: 2,
    ret: "text",
    run: ([t, n]) => {
      const s = asStr(t);
      const count = Math.max(0, Math.floor(asNum(n)));
      if (s === "" || count === 0) return "";
      return capText(s.repeat(Math.min(count, Math.ceil(MAX_TEXT / s.length))));
    },
  },
  ...(["padStart", "padEnd"] as const).map((name): FnDef => ({
    name,
    signature: `${name}(text, length, pad)`,
    description:
      name === "padStart"
        ? "Pads the start of the text with pad until it reaches length."
        : "Pads the end of the text with pad until it reaches length.",
    example: `${name}("7", 3, "0")`,
    category: "text",
    params: ["text", "number", "text"],
    min: 3,
    max: 3,
    ret: "text",
    run: ([t, n, p]) => {
      const cps = toCodePoints(asStr(t));
      const pad = toCodePoints(asStr(p));
      const target = Math.min(MAX_TEXT, Math.trunc(asNum(n)));
      if (pad.length === 0 || cps.length >= target) return asStr(t);
      const fill: number[] = [];
      while (fill.length < target - cps.length) fill.push(...pad);
      const padding = fill.slice(0, target - cps.length);
      return str(name === "padStart" ? [...padding, ...cps] : [...cps, ...padding], 0, target);
    },
  })),
  {
    name: "link",
    signature: "link(text, url)",
    description: "The text as a link to the URL.",
    example: 'link("Docs", "https://example.com")',
    category: "text",
    params: ["rich", "text"],
    min: 2,
    max: 2,
    ret: "text",
    run: ([t, u]) => {
      const url = asStr(u);
      if (url === "") return richArg(t);
      return richOrPlain(runsOf(richArg(t)).map((run) => ({ ...run, link: url })));
    },
  },
  {
    name: "style",
    signature: "style(text, style...)",
    description: 'Styles the text: "b", "i", "u", "s", "c", a color, or "<color>_background".',
    example: 'style("Done", "b", "green")',
    category: "text",
    params: ["rich", "text"],
    min: 1,
    max: Infinity,
    ret: "text",
    literal: (i, v) => (i >= 1 && !isStyleName(v) ? `Unknown style "${v}".` : undefined),
    run: ([t, ...names]) => {
      const valid = names.map((n) => asStr(n)).filter(isStyleName);
      return richOrPlain(runsOf(richArg(t)).map((run) => valid.reduce(applyStyle, run)));
    },
  },
  {
    name: "unstyle",
    signature: "unstyle(text, style...)",
    description: "Removes the named styles, or all styles when none are named.",
    example: 'unstyle(style("Done", "b"))',
    category: "text",
    params: ["rich", "text"],
    min: 1,
    max: Infinity,
    ret: "text",
    literal: (i, v) => (i >= 1 && !isStyleName(v) ? `Unknown style "${v}".` : undefined),
    run: ([t, ...names]) => {
      const named = names.map((n) => asStr(n)).filter(isStyleName);
      if (named.length === 0) return plainText(richArg(t)) ?? "";
      return richOrPlain(runsOf(richArg(t)).map((run) => named.reduce(removeStyle, run)));
    },
  },
  {
    name: "format",
    signature: "format(value)",
    description: "Any value as text.",
    example: 'format(prop("Due"))',
    category: "text",
    params: ["any"],
    min: 1,
    max: 1,
    ret: "text",
    noFar: true,
    run: ([v], rt) =>
      formatValue(v ?? null, { timeZone: rt.tz, titleOf: rt.ctx.titleOf, tick: rt.tick }),
  },
  {
    name: "split",
    signature: "split(text, separator?)",
    description: 'Splits the text into a list. The separator defaults to ",".',
    example: 'split("a,b,c")',
    category: "text",
    params: ["text", "text"],
    min: 1,
    max: 2,
    ret: { list: "text" },
    run: ([t, s]) => {
      const text = asStr(t);
      const sep = typeof s === "string" ? s : ",";
      if (text === "") return [];
      const parts =
        sep === "" ? toCodePoints(text).map((c) => String.fromCodePoint(c)) : text.split(sep);
      return capList(parts);
    },
  },
  {
    name: "join",
    signature: "join(list, separator?)",
    description: 'Joins the items of a list into text. The separator defaults to ",".',
    example: 'join(["a", "b"], "-")',
    category: "text",
    params: ["list", "text"],
    min: 1,
    max: 2,
    ret: "text",
    noFar: true,
    run: ([l, s], rt) => {
      const sep = typeof s === "string" ? s : ",";
      const ctx = { timeZone: rt.tz, titleOf: rt.ctx.titleOf, tick: rt.tick };
      let out = "";
      let first = true;
      for (const item of asList(l)) {
        if (!first) out += sep;
        first = false;
        out += formatValue(item, ctx);
        if (out.length >= MAX_TEXT) break;
      }
      return capText(out);
    },
  },
  {
    name: "toNumber",
    signature: "toNumber(value)",
    description: "A number from text, a checkbox or a date.",
    example: 'toNumber("1,200")',
    category: "text",
    params: ["any"],
    min: 1,
    max: 1,
    ret: "number",
    run: ([v], rt) => {
      if (typeof v === "number") return v;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (v !== undefined && isDateValue(v)) {
        return instantOf(v, v.start, rt.tz);
      }
      const t = plainText(v ?? null);
      return t === null ? null : parseNumberText(t);
    },
  },
  {
    name: "formatNumber",
    signature: "formatNumber(number, format?, decimals?)",
    description:
      'Formats a number: "number", "commas", "percent", or a currency (dollar, euro, pound, yen, rupee, won, yuan).',
    example: 'formatNumber(1234.5, "dollar")',
    category: "text",
    params: ["number", "text", "number"],
    min: 1,
    max: 3,
    ret: "text",
    run: ([n, f, d]) => {
      const format = typeof f === "string" && f !== "" ? f : "number";
      return formatNumber(asNum(n), format, typeof d === "number" ? d : null);
    },
  },
];

function regexProblem(pattern: string): string | undefined {
  const compiled = compileRegex(pattern);
  return compiled.ok ? undefined : `Unsupported regular expression: ${compiled.reason}.`;
}
