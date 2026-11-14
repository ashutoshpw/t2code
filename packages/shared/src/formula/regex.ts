/**
 * Regular expressions without backtracking: a pattern compiles to a small
 * program that a Pike VM runs in O(pattern x input), so user patterns cannot
 * stall evaluation. Matching is case-sensitive and works on code points.
 */

type ClassEscape = "d" | "D" | "w" | "W" | "s" | "S";
type ClassItem = { readonly lo: number; readonly hi: number } | { readonly esc: ClassEscape };

type Node =
  | { readonly t: "char"; readonly c: number }
  | { readonly t: "any" }
  | { readonly t: "class"; readonly neg: boolean; readonly items: ReadonlyArray<ClassItem> }
  | { readonly t: "cat"; readonly xs: ReadonlyArray<Node> }
  | { readonly t: "alt"; readonly xs: ReadonlyArray<Node> }
  | { readonly t: "group"; readonly cap: number | null; readonly x: Node }
  | {
      readonly t: "rep";
      readonly x: Node;
      readonly min: number;
      readonly max: number;
      readonly lazy: boolean;
    }
  | { readonly t: "bol" | "eol" | "wb" | "nwb" | "empty" };

type Instr =
  | { readonly op: "char"; readonly c: number }
  | { readonly op: "any" }
  | { readonly op: "class"; readonly neg: boolean; readonly items: ReadonlyArray<ClassItem> }
  | { readonly op: "split"; readonly x: number; readonly y: number }
  | { readonly op: "jmp"; readonly x: number }
  | { readonly op: "save"; readonly n: number }
  | { readonly op: "bol" | "eol" | "wb" | "nwb" | "match" };

export interface RegexProgram {
  readonly prog: ReadonlyArray<Instr>;
  readonly groups: number;
}
export type RegexCompile =
  | { readonly ok: true; readonly program: RegexProgram }
  | { readonly ok: false; readonly reason: string };

const MAX_PROGRAM = 5000;
const MAX_COUNT = 1000;

class RegexError {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

const fail = (reason: string): never => {
  throw new RegexError(reason);
};

export const toCodePoints = (text: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text.codePointAt(i) ?? 0;
    out.push(c);
    if (c > 0xffff) i += 1;
  }
  return out;
};

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isWordChar = (c: number): boolean =>
  isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isSpaceChar = (c: number): boolean =>
  (c >= 9 && c <= 13) ||
  c === 32 ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff;

function escMatches(esc: ClassEscape, c: number): boolean {
  switch (esc) {
    case "d":
      return isDigit(c);
    case "D":
      return !isDigit(c);
    case "w":
      return isWordChar(c);
    case "W":
      return !isWordChar(c);
    case "s":
      return isSpaceChar(c);
    case "S":
      return !isSpaceChar(c);
  }
}

function classMatches(neg: boolean, items: ReadonlyArray<ClassItem>, c: number): boolean {
  let hit = false;
  for (const item of items) {
    if ("esc" in item ? escMatches(item.esc, c) : c >= item.lo && c <= item.hi) {
      hit = true;
      break;
    }
  }
  return hit !== neg;
}

const cp = (ch: string): number => ch.codePointAt(0) ?? 0;

class PatternParser {
  private i = 0;
  private groupCount = 0;
  private readonly p: ReadonlyArray<number>;

  constructor(p: ReadonlyArray<number>) {
    this.p = p;
  }

  parse(): { readonly node: Node; readonly groups: number } {
    const node = this.alt(0);
    if (this.i < this.p.length) fail("unmatched )");
    return { node, groups: this.groupCount };
  }

  private peek(): number {
    return this.p[this.i] ?? -1;
  }

  private alt(depth: number): Node {
    const branches: Node[] = [this.cat(depth)];
    while (this.peek() === cp("|")) {
      this.i += 1;
      branches.push(this.cat(depth));
    }
    return branches.length === 1 ? (branches[0] ?? { t: "empty" }) : { t: "alt", xs: branches };
  }

  private cat(depth: number): Node {
    const xs: Node[] = [];
    for (;;) {
      const c = this.peek();
      if (c === -1 || c === cp("|") || (c === cp(")") && depth > 0)) break;
      if (c === cp(")")) fail("unmatched )");
      xs.push(this.repeat(depth));
    }
    return xs.length === 0
      ? { t: "empty" }
      : xs.length === 1
        ? (xs[0] ?? { t: "empty" })
        : { t: "cat", xs };
  }

  private quantifier(): { min: number; max: number } | null {
    const c = this.peek();
    if (c === cp("*")) {
      this.i += 1;
      return { min: 0, max: Infinity };
    }
    if (c === cp("+")) {
      this.i += 1;
      return { min: 1, max: Infinity };
    }
    if (c === cp("?")) {
      this.i += 1;
      return { min: 0, max: 1 };
    }
    if (c === cp("{")) return this.braces();
    return null;
  }

  /** `{n}`, `{n,}`, `{n,m}`; anything else is not a quantifier and `{` is a literal. */
  private braces(): { min: number; max: number } | null {
    let j = this.i + 1;
    const digits = (): number | null => {
      const start = j;
      while (isDigit(this.p[j] ?? -1)) j += 1;
      if (j === start) return null;
      return Number(String.fromCodePoint(...this.p.slice(start, j)));
    };
    const min = digits();
    if (min === null) return null;
    let max = min;
    if (this.p[j] === cp(",")) {
      j += 1;
      const hi = digits();
      max = hi === null ? Infinity : hi;
    }
    if (this.p[j] !== cp("}")) return null;
    this.i = j + 1;
    if (min > MAX_COUNT || (max !== Infinity && max > MAX_COUNT)) fail("repeat count is too large");
    if (max < min) fail("repeat range is out of order");
    return { min, max };
  }

  private repeat(depth: number): Node {
    const atom = this.atom(depth);
    const q = this.quantifier();
    if (q === null) return atom;
    if (atom.t === "bol" || atom.t === "eol" || atom.t === "wb" || atom.t === "nwb") {
      fail("nothing to repeat");
    }
    const lazy = this.peek() === cp("?");
    if (lazy) this.i += 1;
    if (this.quantifier() !== null) fail("nothing to repeat");
    return { t: "rep", x: atom, min: q.min, max: q.max, lazy };
  }

  private atom(depth: number): Node {
    const c = this.peek();
    this.i += 1;
    switch (c) {
      case cp("("):
        return this.group(depth);
      case cp("["):
        return this.charClass();
      case cp("."):
        return { t: "any" };
      case cp("^"):
        return { t: "bol" };
      case cp("$"):
        return { t: "eol" };
      case cp("\\"):
        return this.escape();
      case cp("*"):
      case cp("+"):
      case cp("?"):
        return fail("nothing to repeat");
      case cp("{"):
        this.i -= 1;
        if (this.braces() !== null) return fail("nothing to repeat");
        this.i += 1;
        return { t: "char", c };
      default:
        return { t: "char", c };
    }
  }

  private group(depth: number): Node {
    let cap: number | null = null;
    if (this.peek() === cp("?")) {
      const next = this.p[this.i + 1] ?? -1;
      if (next === cp(":")) this.i += 2;
      else if (next === cp("=") || next === cp("!")) return fail("lookahead is not supported");
      else if (next === cp("<")) {
        const after = this.p[this.i + 2] ?? -1;
        return fail(
          after === cp("=") || after === cp("!")
            ? "lookbehind is not supported"
            : "named groups are not supported",
        );
      } else return fail("group modifiers are not supported");
    } else {
      this.groupCount += 1;
      cap = this.groupCount;
    }
    const x = this.alt(depth + 1);
    if (this.peek() !== cp(")")) fail("missing )");
    this.i += 1;
    return { t: "group", cap, x };
  }

  private hex(count: number): number {
    const digits = this.p.slice(this.i, this.i + count);
    if (
      digits.length !== count ||
      !digits.every((d) => /[0-9a-fA-F]/.test(String.fromCodePoint(d)))
    ) {
      return fail("invalid escape");
    }
    this.i += count;
    return Number.parseInt(String.fromCodePoint(...digits), 16);
  }

  private escape(): Node {
    const code = this.simpleEscape(false);
    if (typeof code === "number") return { t: "char", c: code };
    return code;
  }

  /** An escape after the backslash: a code point, or a node for class escapes and boundaries. */
  private simpleEscape(inClass: boolean): number | Node {
    const c = this.peek();
    if (c === -1) return fail("trailing backslash");
    this.i += 1;
    const ch = String.fromCodePoint(c);
    switch (ch) {
      case "d":
      case "D":
      case "w":
      case "W":
      case "s":
      case "S":
        return { t: "class", neg: false, items: [{ esc: ch }] };
      case "b":
        return inClass ? 8 : { t: "wb" };
      case "B":
        return inClass ? fail("invalid escape") : { t: "nwb" };
      case "n":
        return 10;
      case "t":
        return 9;
      case "r":
        return 13;
      case "f":
        return 12;
      case "v":
        return 11;
      case "0":
        return 0;
      case "u":
        return this.hex(4);
      case "x":
        return this.hex(2);
      case "k":
        return fail("backreferences are not supported");
      default:
        if (isDigit(c)) return fail("backreferences are not supported");
        if (isWordChar(c)) return fail(`unknown escape \\${ch}`);
        return c;
    }
  }

  private charClass(): Node {
    let neg = false;
    if (this.peek() === cp("^")) {
      neg = true;
      this.i += 1;
    }
    const items: ClassItem[] = [];
    for (;;) {
      const c = this.peek();
      if (c === -1) fail("missing ]");
      if (c === cp("]")) {
        this.i += 1;
        break;
      }
      const lo = this.classAtom();
      if (typeof lo !== "number") {
        items.push(...lo);
        continue;
      }
      if (
        this.peek() === cp("-") &&
        (this.p[this.i + 1] ?? -1) !== cp("]") &&
        this.p[this.i + 1] !== undefined
      ) {
        this.i += 1;
        const hi = this.classAtom();
        if (typeof hi !== "number") {
          items.push({ lo, hi: lo }, { lo: cp("-"), hi: cp("-") }, ...hi);
          continue;
        }
        if (hi < lo) fail("character range is out of order");
        items.push({ lo, hi });
      } else items.push({ lo, hi: lo });
    }
    return { t: "class", neg, items };
  }

  private classAtom(): number | ReadonlyArray<ClassItem> {
    const c = this.peek();
    this.i += 1;
    if (c !== cp("\\")) return c;
    const e = this.simpleEscape(true);
    if (typeof e === "number") return e;
    return e.t === "class" ? e.items : fail("invalid escape");
  }
}

class Compiler {
  readonly prog: Instr[] = [];

  private push(instr: Instr): number {
    if (this.prog.length >= MAX_PROGRAM) fail("pattern is too complex");
    this.prog.push(instr);
    return this.prog.length - 1;
  }

  private patch(at: number, instr: Instr): void {
    this.prog[at] = instr;
  }

  emit(node: Node): void {
    switch (node.t) {
      case "char":
        this.push({ op: "char", c: node.c });
        return;
      case "any":
        this.push({ op: "any" });
        return;
      case "class":
        this.push({ op: "class", neg: node.neg, items: node.items });
        return;
      case "bol":
      case "eol":
      case "wb":
      case "nwb":
        this.push({ op: node.t });
        return;
      case "empty":
        return;
      case "cat":
        for (const x of node.xs) this.emit(x);
        return;
      case "alt": {
        const jumps: number[] = [];
        node.xs.forEach((x, idx) => {
          if (idx < node.xs.length - 1) {
            const split = this.push({ op: "split", x: 0, y: 0 });
            this.emit(x);
            jumps.push(this.push({ op: "jmp", x: 0 }));
            this.patch(split, { op: "split", x: split + 1, y: this.prog.length });
          } else this.emit(x);
        });
        for (const j of jumps) this.patch(j, { op: "jmp", x: this.prog.length });
        return;
      }
      case "group":
        if (node.cap === null) this.emit(node.x);
        else {
          this.push({ op: "save", n: node.cap * 2 });
          this.emit(node.x);
          this.push({ op: "save", n: node.cap * 2 + 1 });
        }
        return;
      case "rep":
        this.repeat(node);
        return;
    }
  }

  private split(lazy: boolean, bodyAt: number, exitAt: number): Instr {
    return lazy ? { op: "split", x: exitAt, y: bodyAt } : { op: "split", x: bodyAt, y: exitAt };
  }

  private repeat(node: Extract<Node, { t: "rep" }>): void {
    for (let n = 0; n < node.min; n += 1) this.emit(node.x);
    if (node.max === Infinity) {
      const split = this.push({ op: "split", x: 0, y: 0 });
      this.emit(node.x);
      this.push({ op: "jmp", x: split });
      this.patch(split, this.split(node.lazy, split + 1, this.prog.length));
      return;
    }
    const splits: number[] = [];
    for (let n = node.min; n < node.max; n += 1) {
      splits.push(this.push({ op: "split", x: 0, y: 0 }));
      this.emit(node.x);
    }
    for (const s of splits) this.patch(s, this.split(node.lazy, s + 1, this.prog.length));
  }
}

const cache = new Map<string, RegexCompile>();
const CACHE_SIZE = 100;

export function compileRegex(pattern: string): RegexCompile {
  const hit = cache.get(pattern);
  if (hit !== undefined) {
    cache.delete(pattern);
    cache.set(pattern, hit);
    return hit;
  }
  let result: RegexCompile;
  try {
    const { node, groups } = new PatternParser(toCodePoints(pattern)).parse();
    const compiler = new Compiler();
    compiler.emit({ t: "group", cap: 0, x: node });
    compiler.emit({ t: "empty" });
    result = { ok: true, program: { prog: [...compiler.prog, { op: "match" }], groups } };
  } catch (error) {
    if (!(error instanceof RegexError)) throw error;
    result = { ok: false, reason: error.reason };
  }
  if (cache.size >= CACHE_SIZE) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(pattern, result);
  return result;
}

/** Called with the number of VM instructions executed; may throw to stop the match. */
export interface Meter {
  add(instructions: number): void;
}

interface Thread {
  readonly pc: number;
  readonly slots: ReadonlyArray<number>;
}

/**
 * Leftmost match at or after `from` with JavaScript-like priority. Returns the
 * capture slots (pairs of code point offsets, -1 when unset) or null.
 */
export function execRegex(
  program: RegexProgram,
  input: ReadonlyArray<number>,
  from: number,
  meter: Meter,
): ReadonlyArray<number> | null {
  const { prog } = program;
  const n = input.length;
  const slotCount = (program.groups + 1) * 2;
  const empty: ReadonlyArray<number> = new Array<number>(slotCount).fill(-1);
  const marks = new Int32Array(prog.length).fill(-1);
  let work = 0;
  let matched: ReadonlyArray<number> | null = null;

  const word = (i: number): boolean => i >= 0 && i < n && isWordChar(input[i] ?? -1);

  const add = (
    list: Thread[],
    pc0: number,
    pos: number,
    slots0: ReadonlyArray<number>,
    gen: number,
  ): void => {
    const stack: Thread[] = [{ pc: pc0, slots: slots0 }];
    for (let t = stack.pop(); t !== undefined; t = stack.pop()) {
      const { pc, slots } = t;
      if (marks[pc] === gen) continue;
      marks[pc] = gen;
      work += 1;
      const instr = prog[pc];
      if (instr === undefined) continue;
      switch (instr.op) {
        case "jmp":
          stack.push({ pc: instr.x, slots });
          break;
        case "split":
          stack.push({ pc: instr.y, slots }, { pc: instr.x, slots });
          break;
        case "save": {
          const copy = slots.slice();
          copy[instr.n] = pos;
          stack.push({ pc: pc + 1, slots: copy });
          break;
        }
        case "bol":
          if (pos === 0) stack.push({ pc: pc + 1, slots });
          break;
        case "eol":
          if (pos === n) stack.push({ pc: pc + 1, slots });
          break;
        case "wb":
          if (word(pos - 1) !== word(pos)) stack.push({ pc: pc + 1, slots });
          break;
        case "nwb":
          if (word(pos - 1) === word(pos)) stack.push({ pc: pc + 1, slots });
          break;
        default:
          list.push(t);
      }
    }
  };

  let clist: Thread[] = [];
  for (let pos = from; pos <= n; pos += 1) {
    if (matched === null) add(clist, 0, pos, empty, pos);
    if (clist.length === 0) {
      meter.add(work);
      work = 0;
      if (matched !== null || pos >= n) break;
      continue;
    }
    const nlist: Thread[] = [];
    const c = pos < n ? (input[pos] ?? -1) : -1;
    for (const t of clist) {
      work += 1;
      const instr = prog[t.pc];
      if (instr === undefined) continue;
      if (instr.op === "match") {
        matched = t.slots;
        break;
      }
      if (c === -1) continue;
      const ok =
        instr.op === "char"
          ? instr.c === c
          : instr.op === "any"
            ? c !== 10
            : instr.op === "class"
              ? classMatches(instr.neg, instr.items, c)
              : false;
      if (ok) add(nlist, t.pc + 1, pos + 1, t.slots, pos + 1);
    }
    clist = nlist;
    meter.add(work);
    work = 0;
    if (pos >= n) break;
  }
  meter.add(work);
  return matched;
}
