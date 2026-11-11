import type { ParsedNode } from "./ast.ts";
import { lex, type Token } from "./lexer.ts";
import type { FormulaDiagnostic } from "./types.ts";

const MAX_SOURCE = 8192;
const MAX_DEPTH = 64;
const MAX_NODES = 2000;
const MAX_LIST_LITERAL = 100;

class Abort {
  readonly diagnostic: FormulaDiagnostic;
  constructor(diagnostic: FormulaDiagnostic) {
    this.diagnostic = diagnostic;
  }
}

const BINARY_NAMES: Record<string, string> = {
  "+": "add",
  "-": "subtract",
  "*": "multiply",
  "/": "divide",
  "%": "mod",
  "^": "pow",
  "==": "equal",
  "!=": "unequal",
  ">": "larger",
  ">=": "largerEq",
  "<": "smaller",
  "<=": "smallerEq",
};

class Parser {
  private pos = 0;
  private nodes = 0;
  private depth = 0;

  private readonly tokens: ReadonlyArray<Token>;
  private readonly source: string;

  constructor(tokens: ReadonlyArray<Token>, source: string) {
    this.tokens = tokens;
    this.source = source;
  }

  private get tok(): Token {
    return this.tokens[this.pos] ?? (this.tokens[this.tokens.length - 1] as Token);
  }

  private atEnd(): boolean {
    return this.tok.kind === "eof";
  }

  private next(): Token {
    const t = this.tok;
    if (t.kind !== "eof") this.pos += 1;
    return t;
  }

  private fail(
    code: FormulaDiagnostic["code"],
    message: string,
    start: number,
    end: number,
  ): never {
    throw new Abort({ code, message, start, end: Math.max(end, start + 1) });
  }

  private unexpected(t: Token = this.tok, what = "an expression"): never {
    if (t.kind === "eof") {
      const at = Math.max(this.source.length - 1, 0);
      return this.fail("syntax", `Expected ${what}.`, at, this.source.length);
    }
    return this.fail("syntax", `Unexpected "${t.text}".`, t.start, t.end);
  }

  private is(text: string): boolean {
    const t = this.tok;
    return (t.kind === "punct" || t.kind === "kw") && t.text === text;
  }

  private count(t: Token): void {
    this.nodes += 1;
    if (this.nodes > MAX_NODES) this.fail("limit", "The formula is too long.", t.start, t.end);
  }

  private nest<T>(run: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) {
      this.fail("limit", "The formula is nested too deeply.", this.tok.start, this.tok.end);
    }
    try {
      return run();
    } finally {
      this.depth -= 1;
    }
  }

  parseAll(): ParsedNode {
    if (this.atEnd()) return { k: "call", fn: "empty", args: [], s: 0, e: 0, fs: 0, fe: 0 };
    const node = this.expr();
    if (!this.atEnd()) this.unexpected();
    return node;
  }

  private call(fn: string, args: ParsedNode[], at: Token, op?: string): ParsedNode {
    this.count(at);
    const first = args[0];
    const last = args[args.length - 1];
    return {
      k: "call",
      fn,
      args,
      ...(op === undefined ? {} : { op }),
      fs: at.start,
      fe: at.end,
      s: first === undefined ? at.start : Math.min(first.s, at.start),
      e: last === undefined ? at.end : Math.max(last.e, at.end),
    };
  }

  private expr(): ParsedNode {
    return this.nest(() => this.ternary());
  }

  private ternary(): ParsedNode {
    const cond = this.or();
    if (!this.is("?")) return cond;
    const q = this.next();
    const a = this.expr();
    if (!this.is(":")) this.unexpected(this.tok, '":"');
    this.next();
    const b = this.expr();
    return { ...this.call("if", [cond, a, b], q, "?:"), s: cond.s, e: b.e };
  }

  private or(): ParsedNode {
    let left = this.and();
    while (this.is("or") || this.is("||")) {
      const op = this.next();
      const right = this.and();
      left = { ...this.call("or", [left, right], op, op.text), s: left.s, e: right.e };
    }
    return left;
  }

  private and(): ParsedNode {
    let left = this.equality();
    while (this.is("and") || this.is("&&")) {
      const op = this.next();
      const right = this.equality();
      left = { ...this.call("and", [left, right], op, op.text), s: left.s, e: right.e };
    }
    return left;
  }

  private binaryLevel(ops: ReadonlyArray<string>, operand: () => ParsedNode): ParsedNode {
    let left = operand();
    while (this.tok.kind === "punct" && ops.includes(this.tok.text)) {
      const op = this.next();
      const right = operand();
      left = {
        ...this.call(BINARY_NAMES[op.text] ?? op.text, [left, right], op, op.text),
        s: left.s,
        e: right.e,
      };
    }
    return left;
  }

  private equality(): ParsedNode {
    return this.binaryLevel(["==", "!="], () => this.comparison());
  }

  private comparison(): ParsedNode {
    return this.binaryLevel([">", ">=", "<", "<="], () => this.additive());
  }

  private additive(): ParsedNode {
    return this.binaryLevel(["+", "-"], () => this.multiplicative());
  }

  private multiplicative(): ParsedNode {
    return this.binaryLevel(["*", "/", "%"], () => this.unary());
  }

  private unary(): ParsedNode {
    const t = this.tok;
    if (!(this.is("not") || this.is("!") || this.is("-") || this.is("+"))) return this.power();
    this.next();
    const operand = this.nest(() => this.unary());
    const span = { s: t.start, e: operand.e };
    if (t.text === "not" || t.text === "!")
      return { ...this.call("not", [operand], t, t.text), ...span };
    if (t.text === "-") {
      if (operand.k === "num") return { k: "num", v: -operand.v === 0 ? 0 : -operand.v, ...span };
      const zero: ParsedNode = { k: "num", v: 0, s: t.start, e: t.end };
      return { ...this.call("subtract", [zero, operand], t, "-"), ...span };
    }
    const one: ParsedNode = { k: "num", v: 1, s: t.start, e: t.end };
    return { ...this.call("multiply", [one, operand], t, "+"), ...span };
  }

  private power(): ParsedNode {
    const base = this.postfix();
    if (!this.is("^")) return base;
    const op = this.next();
    const exponent = this.nest(() => this.unary());
    return { ...this.call("pow", [base, exponent], op, "^"), s: base.s, e: exponent.e };
  }

  private args(open: Token): { readonly items: ParsedNode[]; readonly close: Token } {
    const out: ParsedNode[] = [];
    if (this.is(")")) return { items: out, close: this.next() };
    for (;;) {
      out.push(this.expr());
      if (this.is(",")) {
        this.next();
        continue;
      }
      if (this.is(")")) return { items: out, close: this.next() };
      if (this.tok.kind === "eof")
        this.fail("syntax", 'Missing closing ")".', open.start, open.end);
      this.unexpected();
    }
  }

  private propLiteral(open: Token): Token {
    const lit = this.tok;
    if (lit.kind !== "str") {
      this.fail(
        "syntax",
        "prop() takes a property name in double quotes.",
        lit.start,
        Math.max(lit.end, lit.start + 1),
      );
    }
    this.next();
    if (!this.is(")")) {
      if (this.tok.kind === "eof")
        this.fail("syntax", 'Missing closing ")".', open.start, open.end);
      this.fail(
        "syntax",
        "prop() takes a property name in double quotes.",
        this.tok.start,
        this.tok.end,
      );
    }
    this.next();
    return lit;
  }

  private propNode(lit: Token, start: number, of?: ParsedNode): ParsedNode {
    this.count(lit);
    return {
      k: "prop",
      name: lit.str ?? "",
      ls: lit.start,
      le: lit.end,
      s: of === undefined ? start : of.s,
      e: lit.end + 1,
      ...(of === undefined ? {} : { of }),
    };
  }

  private postfix(): ParsedNode {
    let node = this.primary();
    while (this.is(".")) {
      this.next();
      const name = this.tok;
      if (
        !(name.kind === "ident" || (name.kind === "kw" && ["and", "or", "not"].includes(name.text)))
      ) {
        this.unexpected(name, "a function name");
      }
      this.next();
      if (name.text === "prop") {
        if (!this.is("("))
          this.fail(
            "syntax",
            "prop() takes a property name in double quotes.",
            name.start,
            name.end,
          );
        const open = this.next();
        node = this.propNode(this.propLiteral(open), name.start, node);
        continue;
      }
      let rest: ParsedNode[] = [];
      let end = name.end;
      if (this.is("(")) {
        const open = this.next();
        const parsed = this.nest(() => this.args(open));
        rest = parsed.items;
        end = parsed.close.end;
      }
      const recv = node;
      node = {
        ...this.call(name.text, [recv, ...rest], name),
        s: recv.s,
        e: Math.max(end, name.end),
      };
    }
    return node;
  }

  private primary(): ParsedNode {
    const t = this.tok;
    switch (t.kind) {
      case "num": {
        this.next();
        if (!Number.isFinite(t.num ?? 0)) this.unexpected(t);
        this.count(t);
        return { k: "num", v: t.num ?? 0, s: t.start, e: t.end };
      }
      case "str":
        this.next();
        this.count(t);
        return { k: "str", v: t.str ?? "", s: t.start, e: t.end };
      case "kw": {
        if (t.text === "true" || t.text === "false") {
          this.next();
          this.count(t);
          return { k: "bool", v: t.text === "true", s: t.start, e: t.end };
        }
        const after = this.tokens[this.pos + 1];
        if (
          after !== undefined &&
          after.kind === "punct" &&
          after.text === "(" &&
          t.text !== "not"
        ) {
          return this.callNamed(t);
        }
        return this.unexpected(t);
      }
      case "ident": {
        const after = this.tokens[this.pos + 1];
        if (after !== undefined && after.kind === "punct" && after.text === "(")
          return this.callNamed(t);
        this.next();
        this.count(t);
        return { k: "var", name: t.text, s: t.start, e: t.end };
      }
      case "punct":
        if (t.text === "(") {
          this.next();
          const inner = this.expr();
          if (!this.is(")")) {
            if (this.tok.kind === "eof")
              this.fail("syntax", 'Missing closing ")".', t.start, t.end);
            this.unexpected();
          }
          const close = this.next();
          return { ...inner, s: t.start, e: close.end };
        }
        if (t.text === "[") return this.listLiteral();
        return this.unexpected(t);
      default:
        return this.unexpected(t);
    }
  }

  private callNamed(name: Token): ParsedNode {
    this.next();
    const open = this.next();
    if (name.text === "prop") {
      const lit = this.propLiteral(open);
      return this.propNode(lit, name.start);
    }
    const { items, close } = this.nest(() => this.args(open));
    return { ...this.call(name.text, items, name), s: name.start, e: close.end };
  }

  private listLiteral(): ParsedNode {
    const open = this.next();
    const items: ParsedNode[] = [];
    this.count(open);
    for (;;) {
      if (this.is("]")) break;
      items.push(this.expr());
      if (items.length > MAX_LIST_LITERAL) {
        this.fail("limit", "The formula is too long.", open.start, this.tok.end);
      }
      if (this.is(",")) {
        this.next();
        continue;
      }
      if (!this.is("]")) {
        if (this.tok.kind === "eof")
          this.fail("syntax", 'Missing closing "]".', open.start, open.end);
        this.unexpected();
      }
    }
    const close = this.next();
    return { k: "list", items, s: open.start, e: close.end };
  }
}

export function parse(source: string): {
  readonly ast: ParsedNode | null;
  readonly diagnostics: ReadonlyArray<FormulaDiagnostic>;
} {
  if (source.length > MAX_SOURCE) {
    return {
      ast: null,
      diagnostics: [
        {
          code: "limit",
          message: "The formula is too long.",
          start: MAX_SOURCE,
          end: source.length,
        },
      ],
    };
  }
  const { tokens, diagnostics } = lex(source);
  if (diagnostics.length > 0) return { ast: null, diagnostics };
  try {
    return { ast: new Parser(tokens, source).parseAll(), diagnostics: [] };
  } catch (error) {
    if (error instanceof Abort) return { ast: null, diagnostics: [error.diagnostic] };
    throw error;
  }
}
