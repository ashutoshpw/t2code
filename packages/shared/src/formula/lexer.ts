import type { FormulaDiagnostic } from "./types.ts";

export type TokenKind = "num" | "str" | "ident" | "kw" | "punct" | "eof";

export interface Token {
  readonly kind: TokenKind;
  /** Source text for punctuation, keywords and identifiers. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly num?: number;
  /** Decoded value of a text literal. */
  readonly str?: string;
  /** False for a text literal that runs to the end of the source. */
  readonly closed?: boolean;
}

export interface LexResult {
  readonly tokens: ReadonlyArray<Token>;
  readonly diagnostics: ReadonlyArray<FormulaDiagnostic>;
}

const KEYWORDS = new Set(["true", "false", "and", "or", "not"]);
const PUNCT2 = new Set(["==", "!=", ">=", "<=", "&&", "||"]);
const PUNCT1 = new Set([
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
  ">",
  "<",
  "!",
]);

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isIdentStart = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);
const isSpace = (c: string): boolean =>
  c === " " || c === "\t" || c === "\r" || c === "\n" || c === " ";

export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: FormulaDiagnostic[] = [];
  const n = source.length;
  const error = (message: string, start: number, end: number): void => {
    diagnostics.push({ code: "syntax", message, start, end: Math.max(end, start + 1) });
  };
  let i = 0;
  while (i < n) {
    const c = source[i] ?? "";
    if (isSpace(c)) {
      i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) {
        error("Unterminated comment.", i, n);
        i = n;
      } else i = close + 2;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
      const start = i;
      while (isDigit(source[i] ?? "")) i += 1;
      if (source[i] === "." && isDigit(source[i + 1] ?? "")) {
        i += 1;
        while (isDigit(source[i] ?? "")) i += 1;
      }
      if (source[i] === "e" || source[i] === "E") {
        let j = i + 1;
        if (source[j] === "+" || source[j] === "-") j += 1;
        if (isDigit(source[j] ?? "")) {
          while (isDigit(source[j] ?? "")) j += 1;
          i = j;
        }
      }
      const text = source.slice(start, i);
      tokens.push({ kind: "num", text, start, end: i, num: Number(text) });
      if (isIdentStart(source[i] ?? "")) {
        error(`Unexpected "${source[i]}".`, i, i + 1);
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      const start = i;
      i += 1;
      let value = "";
      let closed = false;
      while (i < n) {
        const ch = source[i] ?? "";
        if (ch === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (ch !== "\\") {
          value += ch;
          i += 1;
          continue;
        }
        const esc = source[i + 1];
        const simple: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r" };
        if (esc !== undefined && simple[esc] !== undefined) {
          value += simple[esc];
          i += 2;
        } else if (esc === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) {
          value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
          i += 6;
        } else {
          const shown = esc === undefined ? "" : esc;
          error(`Unknown escape "\\${shown}". Write "\\\\${shown}" for a backslash.`, i, i + 2);
          i += esc === undefined ? 1 : 2;
        }
      }
      if (!closed) error("Unterminated text.", start, n);
      tokens.push({ kind: "str", text: source.slice(start, i), start, end: i, str: value, closed });
      continue;
    }
    if (c === "'") {
      const close = source.indexOf("'", i + 1);
      const end = close === -1 ? n : close + 1;
      error("Text must use double quotes.", i, end);
      i = end;
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (isIdentPart(source[i] ?? "")) i += 1;
      const text = source.slice(start, i);
      tokens.push({ kind: KEYWORDS.has(text) ? "kw" : "ident", text, start, end: i });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (PUNCT2.has(two)) {
      tokens.push({ kind: "punct", text: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (PUNCT1.has(c)) {
      tokens.push({ kind: "punct", text: c, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    const cp = source.codePointAt(i) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    error(`Unexpected "${source.slice(i, i + len)}".`, i, i + len);
    i += len;
  }
  tokens.push({ kind: "eof", text: "", start: n, end: n });
  return { tokens, diagnostics };
}
