import type { BoundNode } from "./ast.ts";
import type { CompiledFormula } from "./check.ts";
import { normalizeZone } from "./dates.ts";
import type { FnDef, Lambda, ParamKind } from "./fn.ts";
import { REGISTRY } from "./registry.ts";
import { type EvalContext, type Runtime, createRuntime } from "./runtime.ts";
import {
  type FormulaValue,
  capText,
  isDateValue,
  isListValue,
  isPageValue,
  isRich,
  plainText,
} from "./values.ts";

interface Env {
  readonly name: string;
  readonly value: FormulaValue;
  readonly parent: Env | null;
}

const NIL = Symbol("nil");

function lookup(env: Env | null, name: string): FormulaValue {
  for (let e = env; e !== null; e = e.parent) if (e.name === name) return e.value;
  return null;
}

/** Applies the rules of 1.5 to one argument; NIL makes the whole call empty. */
function coerce(kind: ParamKind, raw: FormulaValue, optional: boolean): FormulaValue | typeof NIL {
  if (optional && raw === null) return null;
  switch (kind) {
    case "any":
    case "textList":
    case "lambda":
      return raw;
    case "text": {
      if (raw === null) return "";
      return plainText(raw) ?? NIL;
    }
    case "unit":
      return plainText(raw) ?? NIL;
    case "rich":
      return raw === null ? "" : typeof raw === "string" || isRich(raw) ? raw : NIL;
    case "number":
      return typeof raw === "number" ? raw : NIL;
    case "boolean":
      return raw === null ? false : typeof raw === "boolean" ? raw : NIL;
    case "date":
      return isDateValue(raw) ? raw : NIL;
    case "list":
      return raw === null ? [] : isListValue(raw) ? raw : NIL;
    case "numArg":
      return raw === null ? [] : isListValue(raw) || typeof raw === "number" ? raw : [];
  }
}

function sanitize(v: FormulaValue): FormulaValue {
  if (typeof v === "number") return Number.isFinite(v) ? (v === 0 ? 0 : v) : null;
  if (typeof v === "string") return capText(v);
  return v;
}

class Evaluator {
  private readonly rt: Runtime;

  constructor(rt: Runtime) {
    this.rt = rt;
  }

  visit(node: BoundNode, env: Env | null): FormulaValue {
    this.rt.tick();
    switch (node.k) {
      case "num":
        return node.v;
      case "str":
        return capText(node.v);
      case "bool":
        return node.v;
      case "list":
        return node.items.map((item) => this.visit(item, env));
      case "var":
        return lookup(env, node.name);
      case "prop": {
        let page = this.rt.ctx.row;
        if (node.of !== undefined) {
          const target = this.visit(node.of, env);
          if (target === null || !isPageValue(target) || target.ds !== node.ds) return null;
          page = { id: target.id, dataSourceId: target.ds };
        }
        return this.rt.ctx.read(page, node.id);
      }
      case "call":
        return this.call(node, env);
      default:
        return null;
    }
  }

  private call(node: Extract<BoundNode, { k: "call" }>, env: Env | null): FormulaValue {
    const { args } = node;
    switch (node.fn) {
      case "if": {
        const [c, a, b] = args;
        if (c === undefined || a === undefined || b === undefined) return null;
        return this.visit(this.visit(c, env) === true ? a : b, env);
      }
      case "ifs": {
        for (let i = 0; i + 1 < args.length; i += 2) {
          const cond = args[i];
          const value = args[i + 1];
          if (cond !== undefined && value !== undefined && this.visit(cond, env) === true)
            return this.visit(value, env);
        }
        const fallback = args.length % 2 === 1 ? args[args.length - 1] : undefined;
        return fallback === undefined ? null : this.visit(fallback, env);
      }
      case "let":
      case "lets": {
        let scope = env;
        for (let i = 0; i + 1 < args.length; i += 2) {
          const name = args[i];
          const value = args[i + 1];
          if (name === undefined || name.k !== "var" || value === undefined) return null;
          scope = { name: name.name, value: this.visit(value, scope), parent: scope };
        }
        const body = args[args.length - 1];
        return body === undefined ? null : this.visit(body, scope);
      }
      case "and":
        for (const a of args) if (this.visit(a, env) !== true) return false;
        return true;
      case "or":
        for (const a of args) if (this.visit(a, env) === true) return true;
        return false;
      default:
        return this.generic(REGISTRY.get(node.fn), args, env);
    }
  }

  private generic(
    def: FnDef | undefined,
    args: ReadonlyArray<BoundNode>,
    env: Env | null,
  ): FormulaValue {
    if (def?.run === undefined) return null;
    const values: FormulaValue[] = [];
    let lambda: Lambda | undefined;
    for (const [i, arg] of args.entries()) {
      const kind = def.params[Math.min(i, def.params.length - 1)] ?? "any";
      if (kind === "lambda") {
        lambda = (item, index) => {
          this.rt.tick();
          return this.visit(arg, {
            name: "current",
            value: item,
            parent: { name: "index", value: index, parent: env },
          });
        };
        values.push(null);
        continue;
      }
      const coerced = coerce(kind, this.visit(arg, env), i >= def.min);
      if (coerced === NIL) return null;
      values.push(coerced);
    }
    this.rt.tick(sizeCost(values));
    const result = sanitize(def.run(values, this.rt, lambda));
    this.rt.tick(sizeCost([result]));
    return result;
  }
}

/** One step per list item and per 256 characters, so size-heavy calls in a lambda spend the budget. */
function sizeCost(values: ReadonlyArray<FormulaValue>): number {
  let cost = 0;
  for (const v of values) {
    if (typeof v === "string") cost += Math.floor(v.length / 256);
    else if (isListValue(v)) cost += v.length;
  }
  return cost;
}

const MAX_RESULT_NODES = 10_000;

/** Nested lists share references, so reachable size is counted, not allocated size. */
function withinNodeCap(root: FormulaValue): boolean {
  let nodes = 0;
  const stack: FormulaValue[] = [root];
  nodes = 1;
  for (let v = stack.pop(); v !== undefined; v = stack.pop()) {
    if (isListValue(v)) {
      for (const item of v) {
        nodes += 1;
        if (nodes > MAX_RESULT_NODES) return false;
        stack.push(item);
      }
    }
  }
  return true;
}

/** Never throws: a spent budget or any internal failure gives the empty value. */
export function evaluate(compiled: CompiledFormula, context: EvalContext): FormulaValue {
  let rt: Runtime | undefined;
  try {
    rt = createRuntime(context, normalizeZone(context.timeZone));
    const result = new Evaluator(rt).visit(compiled.ast, null);
    return withinNodeCap(result) ? result : null;
  } catch {
    return null;
  } finally {
    if (context.meter !== undefined && rt !== undefined) context.meter.steps += rt.spent();
  }
}
