/** Rows and data sources a mutation changed, finalized once at the end of the mutation. */
export interface Touched {
  /** page id -> data source id */
  readonly rows: Map<string, string>;
  /** Data sources whose cell data changed: their data revision is bumped at the end. */
  readonly sources: Set<string>;
  /** Data sources whose schema changed (already bumped); reported as affected. */
  readonly schema: Set<string>;
  /** Properties whose cell changed, per row; `title` stands for the page title. */
  readonly cells: Map<string, { readonly dataSourceId: string; readonly properties: Set<string> }>;
  /** Rows created by the mutation: page id -> data source id. */
  readonly created: Map<string, string>;
}
export const touched = (): Touched => ({
  rows: new Map(),
  sources: new Set(),
  schema: new Set(),
  cells: new Map(),
  created: new Map(),
});

/** Records that `propertyId` of a row changed, so computed values that read it are brought up to date. */
export const recordCell = (
  touched: Touched,
  pageId: string,
  dataSourceId: string,
  propertyId: string,
) => {
  const entry = touched.cells.get(pageId);
  if (entry === undefined)
    touched.cells.set(pageId, { dataSourceId, properties: new Set([propertyId]) });
  else entry.properties.add(propertyId);
};

/** Every data source a mutation changed, the input one first. */
export const affected = (touched: Touched, own: string) => [
  own,
  ...[...new Set([...touched.sources, ...touched.schema])].filter((id) => id !== own),
];
