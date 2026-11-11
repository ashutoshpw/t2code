/** Rows and data sources a mutation changed, finalized once at the end of the mutation. */
export interface Touched {
  /** page id -> data source id */
  readonly rows: Map<string, string>;
  /** Data sources whose cell data changed: their data revision is bumped at the end. */
  readonly sources: Set<string>;
  /** Data sources whose schema changed (already bumped); reported as affected. */
  readonly schema: Set<string>;
}
export const touched = (): Touched => ({ rows: new Map(), sources: new Set(), schema: new Set() });

/** Every data source a mutation changed, the input one first. */
export const affected = (touched: Touched, own: string) => [
  own,
  ...[...new Set([...touched.sources, ...touched.schema])].filter((id) => id !== own),
];
