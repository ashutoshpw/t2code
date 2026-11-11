import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DatabaseStore from "../databases/DatabaseStore.ts";
import { parseJson } from "../databases/Json.ts";
import * as Liveness from "../databases/Liveness.ts";
import * as SchemaStore from "../databases/SchemaStore.ts";
import type { Snapshot } from "../databases/SchemaStore.ts";
import type { DataSourceRecord, DatabaseRecord, ViewRecord } from "../databases/Types.ts";
import { notFound } from "../databases/Types.ts";
import * as ViewStore from "../databases/ViewStore.ts";
import * as PageShares from "../PageShares.ts";
import * as SpacesSql from "../SpacesSql.ts";
import { type Exposed, type InTree, type SharedViewShape, exposed, parseView } from "./Exposure.ts";

const BlockContent = Schema.Struct({
  type: Schema.Literal("database"),
  content: Schema.Struct({
    databaseId: Schema.String,
    viewIds: Schema.Array(Schema.String),
  }),
});
const decodeBlock = Schema.decodeUnknownOption(BlockContent);

export interface BlockScope {
  readonly rootPageId: C.SpacePageId;
  readonly pageId: C.SpacePageId;
  readonly blockId: string;
  readonly database: DatabaseRecord;
  readonly viewIds: readonly string[];
}

export interface ViewScope {
  readonly block: BlockScope;
  readonly view: ViewRecord;
  readonly shape: SharedViewShape;
  readonly source: DataSourceRecord;
  readonly snapshot: Snapshot;
  readonly inTree: InTree;
  /** Data source ids the snapshot names that sit inside the shared tree. */
  readonly tree: ReadonlySet<string>;
  readonly exposed: Exposed;
}

/** Shared between the views of one block so each data source is loaded once. */
export type ScopeCache = Map<
  string,
  { readonly source: DataSourceRecord; readonly snapshot: Snapshot; readonly tree: Set<string> }
>;

const sourcesNamedBy = (snapshot: Snapshot) => {
  const named = new Set<string>([snapshot.source.data_source_id]);
  for (const property of snapshot.live) {
    if (property.type === "relation" && typeof property.config.dataSourceId === "string")
      named.add(property.config.dataSourceId);
    const record = property.computed;
    for (const ref of record?.refs ?? []) named.add(ref.dataSourceId);
    for (const link of record?.deps.related ?? []) named.add(link.dataSourceId);
  }
  return named;
};

const gone = (entity: C.SpaceNotFoundError["entity"], id: string) => notFound(entity, id);

/** The page that holds the database's home block, when that block is not deleted. */
const homePage = Effect.fn("SharedDatabases.homePage")(function* (databaseId: string) {
  const sql = yield* SpacesSql.SpacesSql;
  const [home] = yield* sql<{
    readonly page_id: C.SpacePageId;
  }>`SELECT b.page_id FROM spaces_db_databases d JOIN spaces_blocks b ON b.block_id = d.home_block_id
    WHERE d.database_id = ${databaseId} AND b.deleted = 0`;
  return home?.page_id;
});

/** A database is in the tree when it is live and its home page is the root or a live descendant. */
const databaseInTree = Effect.fn("SharedDatabases.databaseInTree")(function* (
  rootPageId: C.SpacePageId,
  databaseId: string,
) {
  const page = yield* homePage(databaseId);
  if (page === undefined) return false;
  if (!(yield* Liveness.pageLive(page))) return false;
  return (yield* PageShares.locate(rootPageId, page)) !== null;
});

const treeOf = Effect.fn("SharedDatabases.treeOf")(function* (
  rootPageId: C.SpacePageId,
  snapshot: Snapshot,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const decided = new Map<string, boolean>();
  const tree = new Set<string>();
  for (const id of sourcesNamedBy(snapshot)) {
    const [row] = yield* sql<{
      readonly database_id: string;
    }>`SELECT database_id FROM spaces_db_data_sources WHERE data_source_id = ${id}`;
    if (row === undefined) continue;
    const known = decided.get(row.database_id);
    const inside = known ?? (yield* databaseInTree(rootPageId, row.database_id));
    decided.set(row.database_id, inside);
    if (inside) tree.add(id);
  }
  return tree;
});

/** Steps 1 to 3: the block is a live database block of a page in the tree, and its database is too. */
export const resolveBlock = Effect.fn("SharedDatabases.resolveBlock")(function* (
  rootPageId: C.SpacePageId,
  pageId: C.SpacePageId,
  blockId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  if ((yield* PageShares.locate(rootPageId, pageId)) === null) return yield* gone("page", pageId);
  const [row] = yield* sql<{
    readonly payload: string;
  }>`SELECT payload FROM spaces_blocks WHERE block_id = ${blockId} AND page_id = ${pageId} AND deleted = 0`;
  if (row === undefined) return yield* gone("block", blockId);
  const decoded = decodeBlock(
    yield* Effect.try({ try: () => parseJson(row.payload), catch: () => gone("block", blockId) }),
  );
  if (decoded._tag === "None") return yield* gone("block", blockId);
  const { databaseId, viewIds } = decoded.value.content;
  if (!(yield* databaseInTree(rootPageId, databaseId))) return yield* gone("database", databaseId);
  const database = yield* DatabaseStore.getDatabase(databaseId);
  return { rootPageId, pageId, blockId, database, viewIds } satisfies BlockScope;
});

/** Steps 4 to 7: the view is listed on the block, belongs to its database, and can be exposed. */
export const loadView = Effect.fn("SharedDatabases.loadView")(function* (
  block: BlockScope,
  viewId: string,
  cache: ScopeCache,
) {
  if (!block.viewIds.includes(viewId)) return yield* gone("view", viewId);
  const view = yield* ViewStore.getView(viewId);
  if (view.database_id !== block.database.database_id) return yield* gone("view", viewId);
  let loaded = cache.get(view.data_source_id);
  if (loaded === undefined) {
    const source = yield* DatabaseStore.getLiveDataSource(view.data_source_id);
    if (source.database_id !== block.database.database_id)
      return yield* gone("data_source", view.data_source_id);
    const snapshot = yield* SchemaStore.load(source.data_source_id);
    loaded = { source, snapshot, tree: yield* treeOf(block.rootPageId, snapshot) };
    cache.set(view.data_source_id, loaded);
  }
  const { source, snapshot, tree } = loaded;
  const inTree: InTree = (id) => tree.has(id);
  const shape = parseView(view);
  const shown = exposed(snapshot, shape, inTree);
  if (shown === null) return yield* gone("view", viewId);
  return { block, view, shape, source, snapshot, inTree, tree, exposed: shown } satisfies ViewScope;
});

export const resolveView = Effect.fn("SharedDatabases.resolveView")(function* (
  rootPageId: C.SpacePageId,
  pageId: C.SpacePageId,
  blockId: string,
  viewId: string,
) {
  return yield* loadView(yield* resolveBlock(rootPageId, pageId, blockId), viewId, new Map());
});
