import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as PageStore from "../PageStore.ts";
import type { Plan } from "../PageStructure.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as DatabaseStore from "./DatabaseStore.ts";
import * as Dirty from "./computed/Dirty.ts";
import * as Drain from "./computed/Drain.ts";
import { parseJson } from "./Json.ts";
import * as Liveness from "./Liveness.ts";
import * as RelationStore from "./RelationStore.ts";
import { isoNow } from "./Types.ts";

const decodeDatabaseBlock = Schema.decodeUnknownOption(C.SpaceDatabaseBlock, {
  onExcessProperty: "error",
});

/**
 * After a block batch: every database block written by the batch must name a database of the
 * page's space, and the first live block of a database without a live home block adopts it.
 */
export const afterBlocksApplied = Effect.fn("SpacesDatabases.afterBlocksApplied")(function* (
  page: PageStore.PageRow,
  blocksAfter: readonly { readonly id: string; readonly payload: string | null }[],
  nowMs: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const now = isoNow(nowMs);
  for (const written of blocksAfter) {
    if (written.payload === null) continue;
    const decoded = decodeDatabaseBlock(parseJson(written.payload));
    if (decoded._tag !== "Some") continue;
    const block = decoded.value;
    const [otherHome] = yield* sql<{
      readonly database_id: string;
    }>`SELECT database_id FROM spaces_db_databases
      WHERE home_block_id = ${block.id} AND database_id <> ${block.content.databaseId}`;
    if (otherHome !== undefined)
      return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
    const database = yield* DatabaseStore.getDatabase(block.content.databaseId);
    if (database.space_id !== page.space_id)
      return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
    // A database whose purge has begun is never adopted; the block shows the deleted-database message.
    if (database.purge_started_at_ms !== null) continue;
    if (database.home_block_id === block.id) {
      yield* clearMarks(database.database_id, block);
      continue;
    }
    const [home] =
      database.home_block_id === null
        ? []
        : yield* sql<{
            readonly deleted: number;
          }>`SELECT deleted FROM spaces_blocks WHERE block_id = ${database.home_block_id}`;
    if (home !== undefined && home.deleted === 0) {
      yield* clearViewMarks(block);
      continue;
    }
    if ((yield* Liveness.chain(page.page_id)).includes(database.database_id))
      return yield* new C.SpaceValidationError({ reason: "cycle" });
    yield* sql`UPDATE spaces_db_databases SET home_block_id = ${block.id} WHERE database_id = ${database.database_id}`;
    yield* clearMarks(database.database_id, block);
    yield* DatabaseStore.touchDatabase(database.database_id, now);
    // A database appearing or reappearing in lists moves the catalog.
    yield* sql`UPDATE spaces_core SET catalog_revision = catalog_revision + 1 WHERE singleton = 1`;
  }
});

type DatabaseBlock = C.SpaceDatabaseBlock;

/** A view a live block lists, or owns, is not an orphan. */
const clearViewMarks = Effect.fn("SpacesDatabases.clearViewMarks")(function* (
  block: DatabaseBlock,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_db_views SET orphaned_at_ms = NULL
    WHERE orphaned_at_ms IS NOT NULL AND (owner_block_id = ${block.id} OR view_id IN ${sql.in(block.content.viewIds.length === 0 ? [""] : block.content.viewIds)})`;
});

/** A database or view that a live block names again starts a fresh retention period when it dies again. */
const clearMarks = Effect.fn("SpacesDatabases.clearMarks")(function* (
  databaseId: string,
  block: DatabaseBlock,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_db_databases SET orphaned_at_ms = NULL
    WHERE database_id = ${databaseId} AND orphaned_at_ms IS NOT NULL AND purge_started_at_ms IS NULL`;
  yield* clearViewMarks(block);
});

/**
 * Before a move: a row never moves, and a database with its home block in motion stays in its
 * space and never lands inside one of its own rows.
 */
export const guardMove = Effect.fn("SpacesDatabases.guardMove")(function* (plan: Plan) {
  const sql = yield* SpacesSql.SpacesSql;
  if (plan.source?.data_source_id)
    return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
  const pages = plan.movingPages.size === 0 ? [""] : [...plan.movingPages];
  const blocks = plan.selectedBlocks.size === 0 ? [""] : [...plan.selectedBlocks];
  const homes = yield* sql<{
    readonly database_id: string;
    readonly space_id: string;
  }>`SELECT d.database_id, d.space_id FROM spaces_db_databases d JOIN spaces_blocks b ON b.block_id = d.home_block_id
    WHERE b.deleted = 0 AND (b.page_id IN ${sql.in(pages)} OR b.block_id IN ${sql.in(blocks)})`;
  const destination = plan.destination;
  if (!destination) return;
  const destinationSpace =
    destination.kind === "root"
      ? destination.spaceId
      : plan.pages.get(destination.placement.pageId)!.space_id;
  if (plan.pages.get(plan.sourcePageId)?.space_id !== destinationSpace) {
    // A linked block must still name a database of the space it lands in.
    const payloads = [
      ...(plan.selectedBlocks.size === 0
        ? []
        : yield* sql<{
            readonly payload: string;
          }>`SELECT payload FROM spaces_blocks WHERE block_id IN ${sql.in([...plan.selectedBlocks])}
            AND deleted = 0 AND instr(payload, '"type":"database"') > 0`),
      ...(plan.movingPages.size === 0
        ? []
        : yield* sql<{
            readonly payload: string;
          }>`SELECT payload FROM spaces_blocks WHERE page_id IN ${sql.in([...plan.movingPages])}
            AND deleted = 0 AND instr(payload, '"type":"database"') > 0`),
    ];
    for (const { payload } of payloads) {
      const decoded = decodeDatabaseBlock(parseJson(payload));
      if (decoded._tag !== "Some") continue;
      const database = yield* DatabaseStore.getDatabase(decoded.value.content.databaseId);
      if (database.space_id !== destinationSpace)
        return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
    }
  }
  if (homes.length === 0) return;
  if (homes.some((home) => home.space_id !== destinationSpace))
    return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
  if (destination.kind === "child") {
    const passed = yield* Liveness.chain(destination.placement.pageId);
    if (homes.some((home) => passed.includes(home.database_id)))
      return yield* new C.SpaceValidationError({ reason: "cycle" });
  }
});

interface RecoveryRow {
  readonly pageId: string;
  readonly dataSourceId: string | null;
  readonly template: boolean;
}

/** The pages a recovery touches, captured before they may disappear. */
export const recoveryRows = (plan: Plan): RecoveryRow[] =>
  [...plan.recoveryPages].map((pageId) => {
    const row = plan.pages.get(pageId)!;
    return { pageId, dataSourceId: row.data_source_id, template: row.row_template === 1 };
  });

/**
 * Bookkeeping for row pages after trash, restore and permanent delete (section 5.9). Returns the
 * data sources whose rows or computed values changed, for the receipt.
 */
export const afterRecovery = Effect.fn("SpacesDatabases.afterRecovery")(function* (
  operation: "trashPage" | "restorePage" | "permanentlyDeletePage",
  rows: readonly RecoveryRow[],
  nowMs: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const now = isoNow(nowMs);
  const sources = new Map<string, number>();
  for (const row of rows)
    if (row.dataSourceId !== null)
      sources.set(row.dataSourceId, (sources.get(row.dataSourceId) ?? 0) + 1);
  const affected = new Set(sources.keys());
  // Rows that read the affected rows through a relation recompute; a restored row recomputes itself.
  const rowIds = rows.filter((row) => row.dataSourceId !== null).map((row) => row.pageId);
  yield* Dirty.enqueueReferrersOfPages(rowIds);
  if (operation === "restorePage") for (const id of rowIds) yield* Dirty.enqueueRow(id);
  if (operation === "permanentlyDeletePage") {
    const ids = rows.map((row) => row.pageId);
    for (const [id, count] of sources)
      yield* sql`UPDATE spaces_db_data_sources SET row_count = row_count - ${count} WHERE data_source_id = ${id}`;
    for (const id of sources.keys())
      yield* sql`UPDATE spaces_db_data_sources SET default_template_id = NULL
        WHERE data_source_id = ${id} AND default_template_id IN ${sql.in(ids)}`;
    for (const id of yield* RelationStore.purgeInbound(ids)) affected.add(id);
  }
  for (const id of yield* Drain.inMutation()) affected.add(id);
  for (const id of affected) yield* DatabaseStore.bumpData(id, now);
  return [...affected].map((id) => C.SpaceDataSourceId.make(id));
});
