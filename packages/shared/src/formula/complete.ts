import { lex, type Token } from "./lexer.ts";
import { FUNCTIONS, REGISTRY } from "./registry.ts";
import { type FormulaProperty, type FormulaSchema, typeLabel } from "./types.ts";

export interface FormulaCompletion {
  readonly kind: "property" | "function" | "variable";
  readonly label: string;
  /** Text that replaces `[from, to)` of the source. */
  readonly insert: string;
  readonly from: number;
  readonly to: number;
  readonly detail?: string;
}

const LIMIT = 50;

function rank(label: string, prefix: string): number | undefined {
  if (prefix === "") return 1;
  const l = label.toLowerCase();
  const p = prefix.toLowerCase();
  if (l.startsWith(p)) return 0;
  return l.includes(p) ? 1 : undefined;
}

function ranked<T extends { readonly label: string }>(
  items: ReadonlyArray<T>,
  prefix: string,
): T[] {
  const scored = items.flatMap((item, i) => {
    const r = rank(item.label, prefix);
    return r === undefined ? [] : [{ item, r, i }];
  });
  return scored.sort((a, b) => a.r - b.r || a.i - b.i).map((s) => s.item);
}

function propertyCandidates(schema: FormulaSchema, dotted: boolean): FormulaProperty[] {
  const usable = (p: FormulaProperty): boolean => p.deleted !== true && p.broken !== true;
  if (!dotted) return schema.properties.filter(usable);
  const seen = new Set<string>();
  const out: FormulaProperty[] = [];
  for (const rel of schema.properties) {
    if (rel.relationTo === undefined) continue;
    for (const p of schema.source(rel.relationTo) ?? []) {
      if (usable(p) && !seen.has(p.name)) {
        seen.add(p.name);
        out.push(p);
      }
    }
  }
  return out;
}

interface Frame {
  readonly fn: string | null;
  argIndex: number;
  /** Identifier tokens seen in the current argument, for let names. */
  argTokens: Token[];
  readonly names: { readonly name: string; readonly arg: number }[];
}

function scopeAt(tokens: ReadonlyArray<Token>, end: number): { names: string[]; lambda: boolean } {
  const stack: Frame[] = [];
  for (let i = 0; i < end; i += 1) {
    const t = tokens[i];
    if (t === undefined) continue;
    const top = stack[stack.length - 1];
    if (t.kind === "punct" && (t.text === "(" || t.text === "[")) {
      const prev = tokens[i - 1];
      const named =
        t.text === "(" && prev !== undefined && (prev.kind === "ident" || prev.kind === "kw");
      const dotted = named && tokens[i - 2]?.kind === "punct" && tokens[i - 2]?.text === ".";
      stack.push({
        fn: named ? (prev?.text ?? null) : null,
        argIndex: dotted ? 1 : 0,
        argTokens: [],
        names: [],
      });
    } else if (t.kind === "punct" && (t.text === ")" || t.text === "]")) {
      stack.pop();
    } else if (top !== undefined && t.kind === "punct" && t.text === ",") {
      const only = top.argTokens.length === 1 ? top.argTokens[0] : undefined;
      if (only !== undefined && only.kind === "ident")
        top.names.push({ name: only.text, arg: top.argIndex });
      top.argIndex += 1;
      top.argTokens = [];
    } else if (top !== undefined) top.argTokens.push(t);
  }
  const names: string[] = [];
  let lambda = false;
  for (const frame of stack) {
    if (frame.fn === "let" || frame.fn === "lets") {
      for (const n of frame.names)
        if (n.arg % 2 === 0 && n.arg + 2 <= frame.argIndex) names.push(n.name);
    }
    const def = frame.fn === null ? undefined : REGISTRY.get(frame.fn);
    if (def !== undefined && def.params[frame.argIndex] === "lambda") lambda = true;
  }
  return { names, lambda };
}

export function completions(
  source: string,
  offset: number,
  schema: FormulaSchema,
): ReadonlyArray<FormulaCompletion> {
  const { tokens } = lex(source);
  const at = Math.min(Math.max(offset, 0), source.length);
  const index = tokens.findIndex(
    (t) => t.kind === "str" && at > t.start && (t.closed === true ? at < t.end : at <= t.end),
  );
  const strTok = index === -1 ? undefined : tokens[index];
  if (strTok !== undefined) {
    const isProp = tokens[index - 1]?.text === "(" && tokens[index - 2]?.text === "prop";
    if (!isProp) return [];
    const dotted = tokens[index - 3]?.kind === "punct" && tokens[index - 3]?.text === ".";
    const closed = strTok.closed === true;
    const from = strTok.start + 1;
    const to = closed ? strTok.end - 1 : strTok.end;
    const prefix = source.slice(from, at);
    const items = propertyCandidates(schema, dotted).map((p) => ({
      kind: "property" as const,
      label: p.name,
      insert: JSON.stringify(p.name).slice(1, -1) + (closed ? "" : '"'),
      from,
      to,
      detail: typeLabel(p.type),
    }));
    return ranked(items, prefix).slice(0, LIMIT);
  }

  const wordIndex = tokens.findIndex(
    (t) =>
      (t.kind === "ident" || t.kind === "kw" || t.kind === "num") && at > t.start && at <= t.end,
  );
  const word = wordIndex === -1 ? undefined : tokens[wordIndex];
  if (word?.kind === "num") return [];
  const from = word?.start ?? at;
  const to = word?.end ?? at;
  const prefix = word === undefined ? "" : source.slice(word.start, at);
  let before = wordIndex - 1;
  if (wordIndex === -1) {
    before = -1;
    for (const [i, t] of tokens.entries()) if (t.end <= at && t.kind !== "eof") before = i;
  }
  const prev = tokens[before];
  const afterDot = prev?.kind === "punct" && prev.text === ".";

  const functions = FUNCTIONS.map((f) => ({
    kind: "function" as const,
    label: f.name,
    insert: f.name === "prop" ? 'prop("' : `${f.name}(`,
    from,
    to,
    detail: f.signature,
  }));
  if (afterDot) return ranked(functions, prefix).slice(0, LIMIT);

  const scope = scopeAt(tokens, wordIndex === -1 ? before + 1 : wordIndex);
  const variables = [
    ...[...scope.names].reverse(),
    ...(scope.lambda ? ["current", "index"] : []),
  ].map((name) => ({
    kind: "variable" as const,
    label: name,
    insert: name,
    from,
    to,
    detail:
      name === "current" ? "the list item" : name === "index" ? "the item's position" : "variable",
  }));
  const propFn = {
    kind: "function" as const,
    label: "prop",
    insert: 'prop("',
    from,
    to,
    detail: 'prop("Name")',
  };
  return [...ranked(variables, prefix), ...ranked([propFn, ...functions], prefix)].slice(0, LIMIT);
}
