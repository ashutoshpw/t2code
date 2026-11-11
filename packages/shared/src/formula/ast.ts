/** Stored tree: property ids instead of names, no source offsets. */
export type BoundNode =
  | { readonly k: "num"; readonly v: number }
  | { readonly k: "str"; readonly v: string }
  | { readonly k: "bool"; readonly v: boolean }
  | { readonly k: "list"; readonly items: ReadonlyArray<BoundNode> }
  | { readonly k: "var"; readonly name: string }
  | { readonly k: "prop"; readonly id: string; readonly ds: string; readonly of?: BoundNode }
  | { readonly k: "call"; readonly fn: string; readonly args: ReadonlyArray<BoundNode> };

interface Span {
  /** UTF-16 offsets into the source, `e` exclusive. */
  readonly s: number;
  readonly e: number;
}

/** Parser output. Operators are already calls; `a.f(b)` is already `f(a, b)`. */
export type ParsedNode =
  | (Span & { readonly k: "num"; readonly v: number })
  | (Span & { readonly k: "str"; readonly v: string })
  | (Span & { readonly k: "bool"; readonly v: boolean })
  | (Span & { readonly k: "list"; readonly items: ReadonlyArray<ParsedNode> })
  | (Span & { readonly k: "var"; readonly name: string })
  | (Span & {
      readonly k: "prop";
      /** Property name from the source (name mode); absent when rechecking by id. */
      readonly name?: string;
      readonly id?: string;
      readonly ds?: string;
      readonly of?: ParsedNode;
      /** Span of the string literal, quotes included. */
      readonly ls: number;
      readonly le: number;
    })
  | (Span & {
      readonly k: "call";
      readonly fn: string;
      readonly args: ReadonlyArray<ParsedNode>;
      /** Operator text for messages when this call came from an operator. */
      readonly op?: string;
      /** Span of the function name (or the operator token). */
      readonly fs: number;
      readonly fe: number;
    });
