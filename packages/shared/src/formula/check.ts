import type { BoundNode, ParsedNode } from "./ast.ts";
import type { FnDef, ParamKind, RuleError } from "./fn.ts";
import { parse } from "./parser.ts";
import { REGISTRY } from "./registry.ts";
import {
  FORMULA_VERSION,
  type FormulaDeps,
  type FormulaDiagnostic,
  type FormulaErrorCode,
  type FormulaProperty,
  type FormulaRef,
  type FormulaSchema,
  type FormulaType,
  containsFarPage,
  elementType,
  farify,
  isListType,
  isPageType,
  typeLabel,
  unify,
} from "./types.ts";

export interface CompiledFormula {
  readonly v: 1;
  readonly ast: BoundNode;
  readonly refs: ReadonlyArray<FormulaRef>;
  readonly type: FormulaType;
  readonly deps: FormulaDeps;
  readonly volatile: boolean;
}

export interface CheckResult {
  readonly compiled: CompiledFormula | null;
  readonly diagnostics: ReadonlyArray<FormulaDiagnostic>;
}

type Env = ReadonlyMap<string, FormulaType>;
interface Checked {
  readonly node: BoundNode;
  readonly type: FormulaType;
}

const NONE: BoundNode = { k: "call", fn: "empty", args: [] };
const RESERVED = new Set(["current", "index"]);
const LAMBDA_KINDS: ReadonlySet<ParamKind> = new Set<ParamKind>(["lambda"]);

function accepts(kind: ParamKind, t: FormulaType): boolean {
  if (t === "any" || t === "empty") return true;
  switch (kind) {
    case "text":
    case "rich":
    case "unit":
      return t === "text";
    case "number":
      return t === "number";
    case "boolean":
      return t === "boolean";
    case "date":
      return t === "date";
    case "list":
      return isListType(t);
    case "numArg":
      return t === "number" || (isListType(t) && accepts("number", t.list));
    case "textList":
      return t === "text" || isListType(t);
    default:
      return true;
  }
}

const expectedLabel = (kind: ParamKind): string => {
  switch (kind) {
    case "rich":
    case "unit":
      return "text";
    case "numArg":
      return "number";
    case "textList":
      return "text or list";
    default:
      return kind;
  }
};

function arityText(def: FnDef): string {
  const noun = (n: number): string => (n === 1 ? "argument" : "arguments");
  if (def.max === Infinity) return `at least ${def.min} ${noun(def.min)}`;
  if (def.min === def.max) return `${def.min} ${noun(def.max)}`;
  return `${def.min} to ${def.max} arguments`;
}

class Checker {
  readonly diagnostics: FormulaDiagnostic[] = [];
  readonly refs: FormulaRef[] = [];
  private readonly own = new Set<string>();
  private readonly ownRelations = new Map<string, FormulaProperty>();
  private readonly pageReads = new Map<string, Set<string>>();
  volatile = false;

  private readonly schema: FormulaSchema;

  constructor(schema: FormulaSchema) {
    this.schema = schema;
  }

  private report(code: FormulaErrorCode, message: string, start: number, end: number): void {
    this.diagnostics.push({ code, message, start, end: Math.max(end, start + 1) });
  }

  private reportAt(code: FormulaErrorCode, message: string, node: ParsedNode): void {
    this.report(code, message, node.s, node.e);
  }

  private propertiesOf(ds: string): ReadonlyArray<FormulaProperty> | undefined {
    return ds === this.schema.dataSourceId ? this.schema.properties : this.schema.source(ds);
  }

  deps(): FormulaDeps {
    const related = [...this.ownRelations.values()].flatMap((rel) => {
      const ds = rel.relationTo;
      if (ds === undefined) return [];
      const ids = new Set(this.pageReads.get(ds) ?? []);
      ids.add("title");
      return [{ relationPropertyId: rel.id, dataSourceId: ds, propertyIds: [...ids] }];
    });
    return { own: [...this.own], related };
  }

  check(node: ParsedNode, env: Env): Checked {
    switch (node.k) {
      case "num":
        return { node: { k: "num", v: node.v }, type: "number" };
      case "str":
        return { node: { k: "str", v: node.v }, type: "text" };
      case "bool":
        return { node: { k: "bool", v: node.v }, type: "boolean" };
      case "list": {
        const items = node.items.map((item) => this.check(item, env));
        let item: FormulaType = "empty";
        let mixed = false;
        for (const c of items) {
          const u = unify(item, c.type);
          if (u === undefined) mixed = true;
          else item = u;
        }
        return {
          node: { k: "list", items: items.map((c) => c.node) },
          type: { list: mixed ? "any" : item },
        };
      }
      case "var": {
        const t = env.get(node.name);
        if (t !== undefined) return { node: { k: "var", name: node.name }, type: t };
        this.reportAt(
          "unknown_variable",
          RESERVED.has(node.name)
            ? `"${node.name}" can only be used inside a list function such as map or filter.`
            : `"${node.name}" is not defined.`,
          node,
        );
        return { node: NONE, type: "any" };
      }
      case "prop":
        return this.checkProp(node, env);
      case "call":
        return this.checkCall(node, env);
    }
  }

  private checkProp(node: Extract<ParsedNode, { k: "prop" }>, env: Env): Checked {
    let ds = this.schema.dataSourceId;
    let ofChecked: Checked | undefined;
    if (node.of !== undefined) {
      ofChecked = this.check(node.of, env);
      const t = ofChecked.type;
      if (t === "any" || t === "empty") {
        if (!this.hasErrorIn(node.of))
          this.reportAt("type", `prop expects page here, got ${typeLabel(t)}.`, node);
        return { node: NONE, type: "any" };
      }
      if (isListType(t)) {
        this.reportAt(
          "type",
          "This is a list of pages. Use map to read a property of each page.",
          node,
        );
        return { node: NONE, type: "any" };
      }
      if (!isPageType(t)) {
        this.reportAt("type", `prop expects page here, got ${typeLabel(t)}.`, node);
        return { node: NONE, type: "any" };
      }
      if (t.far === true) {
        const name = this.schema.databaseName?.(t.page);
        this.reportAt(
          "type",
          `Formulas can read properties one relation away. Add a formula or rollup on ${name === undefined ? "that database" : `"${name}"`} to reach further.`,
          node,
        );
        return { node: NONE, type: "any" };
      }
      ds = t.page;
    }
    const props = this.propertiesOf(ds);
    if (props === undefined) {
      this.reportAt("type", "The properties of that database are not available.", node);
      return { node: NONE, type: "any" };
    }
    const found =
      node.id !== undefined
        ? props.find((p) => p.id === node.id)
        : (props.find((p) => p.name === node.name && p.deleted !== true) ??
          props.find((p) => p.name === node.name));
    const label = found?.name ?? node.name ?? node.id ?? "";
    if (found === undefined || found.deleted === true || found.broken === true) {
      this.report(
        "unknown_property",
        found === undefined
          ? `There is no property named "${label}".`
          : found.deleted === true
            ? `The property "${label}" was deleted.`
            : `The property "${label}" has an error.`,
        node.ls,
        node.le,
      );
      return { node: NONE, type: "any" };
    }
    let type = found.type;
    if (ofChecked !== undefined) {
      if (found.volatile === true) {
        this.reportAt(
          "type",
          "A property that uses now() or today() cannot be read from another page.",
          node,
        );
        return { node: NONE, type: "any" };
      }
      type = farify(type);
      const reads = this.pageReads.get(ds) ?? new Set<string>();
      reads.add(found.id);
      this.pageReads.set(ds, reads);
    } else {
      this.own.add(found.id);
      if (found.relationTo !== undefined) this.ownRelations.set(found.id, found);
      if (found.volatile === true) this.volatile = true;
    }
    this.refs.push({ start: node.ls, end: node.le, dataSourceId: ds, propertyId: found.id });
    return {
      node: {
        k: "prop",
        id: found.id,
        ds,
        ...(ofChecked === undefined ? {} : { of: ofChecked.node }),
      },
      type,
    };
  }

  /** True when checking `node` already reported something inside its span. */
  private hasErrorIn(node: ParsedNode): boolean {
    return this.diagnostics.some((d) => d.start >= node.s && d.end <= node.e);
  }

  private nameOf(arg: ParsedNode): string | undefined {
    if (arg.k === "var" && !RESERVED.has(arg.name)) return arg.name;
    this.reportAt("syntax", "Expected a variable name.", arg);
    return undefined;
  }

  private checkLet(node: Extract<ParsedNode, { k: "call" }>, env: Env): Checked {
    const args = node.args;
    const bound: BoundNode[] = [];
    let scope = env;
    const pairs = Math.floor((args.length - 1) / 2);
    for (let i = 0; i < pairs; i += 1) {
      const nameArg = args[i * 2];
      const valueArg = args[i * 2 + 1];
      if (nameArg === undefined || valueArg === undefined) break;
      const name = this.nameOf(nameArg);
      const value = this.check(valueArg, scope);
      bound.push({ k: "var", name: name ?? "_" }, value.node);
      if (name !== undefined) scope = new Map(scope).set(name, value.type);
    }
    const bodyArg = args[args.length - 1];
    if (bodyArg === undefined) return { node: NONE, type: "any" };
    const body = this.check(bodyArg, scope);
    return { node: { k: "call", fn: node.fn, args: [...bound, body.node] }, type: body.type };
  }

  private checkCall(node: Extract<ParsedNode, { k: "call" }>, env: Env): Checked {
    const shown = node.op ?? node.fn;
    const def = REGISTRY.get(node.fn);
    if (def === undefined || def.internal === true) {
      this.report("unknown_function", `There is no function named "${node.fn}".`, node.fs, node.fe);
      return { node: NONE, type: "any" };
    }
    if (def.unsupported === true) {
      this.report("unsupported", "People properties are not supported.", node.fs, node.fe);
      return { node: NONE, type: "any" };
    }
    const n = node.args.length;
    if (n < def.min || n > def.max || (node.fn === "lets" && n % 2 === 0)) {
      this.report(
        "arity",
        node.fn === "lets"
          ? `lets takes an odd number of arguments (at least 3), got ${n}.`
          : `${shown} takes ${arityText(def)}, got ${n}.`,
        node.fs,
        node.fe,
      );
      if (node.fn !== "let" && node.fn !== "lets")
        for (const arg of node.args) this.check(arg, env);
      return { node: NONE, type: "any" };
    }
    if (def.volatile === true) this.volatile = true;
    if (node.fn === "let" || node.fn === "lets") return this.checkLet(node, env);

    const checked: Checked[] = [];
    const errorsBefore = this.diagnostics.length;
    for (const [i, arg] of node.args.entries()) {
      const kind = def.params[Math.min(i, def.params.length - 1)];
      if (kind === undefined || !LAMBDA_KINDS.has(kind)) {
        checked.push(this.check(arg, env));
        continue;
      }
      const itemType = elementType(checked[0]?.type ?? "any") ?? "any";
      checked.push(this.check(arg, new Map(env).set("current", itemType).set("index", "number")));
    }
    const types = checked.map((c) => c.type);
    if (this.diagnostics.length > errorsBefore) return { node: NONE, type: "any" };
    const argNode = (i: number): ParsedNode => node.args[i] ?? node;

    let fn = def.name;
    let activeDef = def;
    if (def.name === "add" && (types[0] === "text" || types[1] === "text")) {
      const text = REGISTRY.get("addText");
      if (text !== undefined) {
        fn = "addText";
        activeDef = text;
      }
    }

    let result: FormulaType = "any";
    if (def.rule !== undefined) {
      const r: FormulaType | RuleError = def.rule(types, shown);
      if (typeof r === "object" && "error" in r) {
        this.reportAt("type", r.error, r.arg === undefined ? node : argNode(r.arg));
      } else result = r;
    } else {
      node.args.forEach((arg, i) => {
        const kind = def.params[Math.min(i, def.params.length - 1)];
        const t = types[i];
        if (kind === undefined || t === undefined || kind === "lambda") return;
        if (!accepts(kind, t)) {
          this.reportAt(
            "type",
            `${shown} expects ${expectedLabel(kind)} here, got ${typeLabel(t)}.`,
            arg,
          );
        }
      });
      result = typeof def.ret === "function" ? def.ret(types) : def.ret;
    }
    if (def.lambdaKind === "boolean") {
      const idx = def.params.indexOf("lambda");
      const t = types[idx];
      if (t !== undefined && t !== "boolean" && t !== "any" && t !== "empty") {
        this.reportAt("type", `${shown} expects boolean here, got ${typeLabel(t)}.`, argNode(idx));
      }
    }
    if (activeDef.noFar === true || def.noFar === true) {
      const far = types.findIndex(containsFarPage);
      if (far !== -1) {
        this.reportAt(
          "type",
          "Pages from a related database cannot be converted to text.",
          argNode(far),
        );
      }
    }
    if (def.literal !== undefined) {
      node.args.forEach((arg, i) => {
        if (arg.k !== "str") return;
        const message = def.literal?.(i, arg.v);
        if (message !== undefined) this.reportAt("type", message, arg);
      });
    }
    return { node: { k: "call", fn, args: checked.map((c) => c.node) }, type: result };
  }
}

function finish(checker: Checker, root: Checked): CheckResult {
  const diagnostics = [...checker.diagnostics].sort((a, b) => a.start - b.start);
  if (diagnostics.length > 0) return { compiled: null, diagnostics };
  return {
    compiled: {
      v: FORMULA_VERSION,
      ast: root.node,
      refs: checker.refs,
      type: root.type,
      deps: checker.deps(),
      volatile: checker.volatile,
    },
    diagnostics,
  };
}

export function compile(source: string, schema: FormulaSchema): CheckResult {
  const parsed = parse(source);
  if (parsed.ast === null) return { compiled: null, diagnostics: parsed.diagnostics };
  const checker = new Checker(schema);
  return finish(checker, checker.check(parsed.ast, new Map()));
}

/** Rebuilds a parse tree from a stored one; spans come from the stored refs where known. */
function toParsed(
  node: BoundNode,
  refs: ReadonlyArray<FormulaRef>,
  next: { i: number },
): ParsedNode {
  const span = { s: 0, e: 1 };
  switch (node.k) {
    case "num":
    case "str":
    case "bool":
    case "var":
      return { ...node, ...span };
    case "list":
      return { k: "list", items: node.items.map((item) => toParsed(item, refs, next)), ...span };
    case "prop": {
      const of = node.of === undefined ? undefined : toParsed(node.of, refs, next);
      const ref = refs[next.i];
      next.i += 1;
      const ls = ref?.start ?? 0;
      const le = ref?.end ?? 1;
      return {
        k: "prop",
        id: node.id,
        ds: node.ds,
        ls,
        le,
        s: ls,
        e: le,
        ...(of === undefined ? {} : { of }),
      };
    }
    case "call":
      return {
        k: "call",
        fn: node.fn === "addText" ? "add" : node.fn,
        args: node.args.map((a) => toParsed(a, refs, next)),
        fs: 0,
        fe: 1,
        ...span,
      };
  }
}

/** Checks a stored formula against the current schema by property ids; it has no source. */
export function recheck(compiled: CompiledFormula, schema: FormulaSchema): CheckResult {
  const checker = new Checker(schema);
  const tree = toParsed(compiled.ast, compiled.refs, { i: 0 });
  return finish(checker, checker.check(tree, new Map()));
}
