import type { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  deadDatabasePurgeRows,
  deadDatabaseRetentionMs,
  orphanViewPurgeRows,
  orphanViewRetentionMs,
} from "../CorePolicy.ts";
import * as DatabaseStore from "../databases/DatabaseStore.ts";
import * as Ids from "../databases/Ids.ts";
import { parseJson } from "../databases/Json.ts";
import { isoNow } from "../databases/Types.ts";
import * as PageStructure from "../PageStructure.ts";
import * as SpacesSql from "../SpacesSql.ts";
import { finishRecovery } from "./Execute.ts";

/**
 * Removes what nothing can reach any more, long after it could have been restored. A database is
 * dead when its home block is gone; it is marked, kept for the retention period, and only then
 * emptied in bounded passes. Nothing here runs for a database with a live home block, whatever
 * the state of its host page.
 */

const decodeDatabaseBlock = Schema.decodeUnknownOption(C.SpaceDatabaseBlock, {
  onExcessProperty: "error",
});
const MAX_NAMING_BLOCKS = 200;
const needleOf = (databaseId: string) => `"databaseId":"${databaseId}"`;

interface ViewPick {
  readonly databaseId: string;
  readonly views: readonly { readonly id: string; readonly mark: number }[];
  /** View ids that a live block lists; only trustworthy when `complete`. */
  readonly listed: ReadonlySet<string>;
  readonly complete: boolean;
}

/** What the read path found: the work the write path may do, each item re-checked there. */
interface Survey {
  /** A database whose purge has started and still holds row pages or views. */
  readonly purging: string | undefined;
  readonly candidate:
    | { readonly databaseId: string; readonly mark: number; readonly named: boolean }
    | undefined;
  readonly views: ViewPick | undefined;
  /** Whether any database or view needs its mark set or cleared. */
  readonly marks: boolean;
}

const idsIn = (ids: ReadonlySet<string>) => (ids.size === 0 ? [""] : [...ids]);

export const survey = Effect.fn("SpacesDatabaseSweep.survey")(function* (
  nowMs: number,
  skipped: ReadonlySet<string>,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const [purging] = yield* sql<{
    readonly database_id: string;
  }>`SELECT d.database_id FROM spaces_db_databases d WHERE d.purge_started_at_ms IS NOT NULL AND (
      EXISTS (SELECT 1 FROM spaces_pages p JOIN spaces_db_data_sources s ON s.data_source_id = p.data_source_id
        WHERE s.database_id = d.database_id AND p.page_id NOT IN ${sql.in(idsIn(skipped))})
      OR EXISTS (SELECT 1 FROM spaces_db_views v WHERE v.database_id = d.database_id))
    ORDER BY d.purge_started_at_ms, d.database_id LIMIT 1`;
  const [fresh] =
    purging === undefined
      ? yield* sql<{
          readonly database_id: string;
          readonly orphaned_at_ms: number;
        }>`SELECT d.database_id, d.orphaned_at_ms FROM spaces_db_databases d
          WHERE d.purge_started_at_ms IS NULL AND d.orphaned_at_ms IS NOT NULL
          AND d.orphaned_at_ms <= ${nowMs - deadDatabaseRetentionMs}
          AND NOT EXISTS (SELECT 1 FROM spaces_blocks b WHERE b.block_id = d.home_block_id AND b.deleted = 0)
          ORDER BY d.orphaned_at_ms, d.database_id LIMIT 1`
      : [];
  const named =
    fresh === undefined
      ? false
      : (yield* sql`SELECT 1 FROM spaces_blocks WHERE deleted = 0 AND instr(payload, ${needleOf(fresh.database_id)}) > 0 LIMIT 1`)
          .length > 0;
  const viewCutoff = nowMs - orphanViewRetentionMs;
  const [firstView] = yield* sql<{
    readonly database_id: string;
  }>`SELECT database_id FROM spaces_db_views WHERE orphaned_at_ms IS NOT NULL AND orphaned_at_ms <= ${viewCutoff}
    ORDER BY orphaned_at_ms, view_id LIMIT 1`;
  let views: ViewPick | undefined;
  if (firstView !== undefined) {
    const picked = yield* sql<{
      readonly view_id: string;
      readonly orphaned_at_ms: number;
    }>`SELECT view_id, orphaned_at_ms FROM spaces_db_views
      WHERE database_id = ${firstView.database_id} AND orphaned_at_ms IS NOT NULL AND orphaned_at_ms <= ${viewCutoff}
      ORDER BY orphaned_at_ms, view_id LIMIT ${orphanViewPurgeRows}`;
    const blocks = yield* sql<{
      readonly payload: string;
    }>`SELECT payload FROM spaces_blocks WHERE deleted = 0 AND instr(payload, ${needleOf(firstView.database_id)}) > 0
      LIMIT ${MAX_NAMING_BLOCKS + 1}`;
    const listed = new Set<string>();
    let complete = blocks.length <= MAX_NAMING_BLOCKS;
    for (const { payload } of blocks.slice(0, MAX_NAMING_BLOCKS)) {
      const decoded = decodeDatabaseBlock(parseJson(payload));
      if (decoded._tag !== "Some") complete = false;
      else for (const id of decoded.value.content.viewIds) listed.add(id);
    }
    views = {
      databaseId: firstView.database_id,
      views: picked.map((view) => ({ id: view.view_id, mark: view.orphaned_at_ms })),
      listed,
      complete,
    };
  }
  const [unmarked] =
    yield* sql`SELECT 1 FROM spaces_db_databases d WHERE d.purge_started_at_ms IS NULL AND (
      (d.orphaned_at_ms IS NULL AND NOT EXISTS (SELECT 1 FROM spaces_blocks b WHERE b.block_id = d.home_block_id AND b.deleted = 0))
      OR (d.orphaned_at_ms IS NOT NULL AND EXISTS (SELECT 1 FROM spaces_blocks b WHERE b.block_id = d.home_block_id AND b.deleted = 0)))
    UNION ALL SELECT 1 FROM spaces_db_views v WHERE
      (v.orphaned_at_ms IS NULL AND v.owner_block_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM spaces_blocks b WHERE b.block_id = v.owner_block_id AND b.deleted = 0))
      OR (v.orphaned_at_ms IS NOT NULL AND EXISTS (SELECT 1 FROM spaces_blocks b WHERE b.block_id = v.owner_block_id AND b.deleted = 0))
    LIMIT 1`;
  return {
    purging: purging?.database_id,
    candidate:
      fresh === undefined
        ? undefined
        : { databaseId: fresh.database_id, mark: fresh.orphaned_at_ms, named },
    views,
    marks: unmarked !== undefined,
  } satisfies Survey;
});

export const idle = (found: Survey) =>
  found.purging === undefined &&
  found.candidate === undefined &&
  found.views === undefined &&
  !found.marks;

const markAndClear = Effect.fn("SpacesDatabaseSweep.markAndClear")(function* (nowMs: number) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_db_databases SET orphaned_at_ms = ${nowMs}
    WHERE orphaned_at_ms IS NULL AND purge_started_at_ms IS NULL
    AND NOT EXISTS (SELECT 1 FROM spaces_blocks b WHERE b.block_id = spaces_db_databases.home_block_id AND b.deleted = 0)`;
  yield* sql`UPDATE spaces_db_databases SET orphaned_at_ms = NULL
    WHERE orphaned_at_ms IS NOT NULL AND purge_started_at_ms IS NULL
    AND EXISTS (SELECT 1 FROM spaces_blocks b WHERE b.block_id = spaces_db_databases.home_block_id AND b.deleted = 0)`;
  yield* sql`UPDATE spaces_db_views SET orphaned_at_ms = ${nowMs}
    WHERE orphaned_at_ms IS NULL AND owner_block_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM spaces_blocks b WHERE b.block_id = spaces_db_views.owner_block_id AND b.deleted = 0)`;
  yield* sql`UPDATE spaces_db_views SET orphaned_at_ms = NULL
    WHERE orphaned_at_ms IS NOT NULL
    AND EXISTS (SELECT 1 FROM spaces_blocks b WHERE b.block_id = spaces_db_views.owner_block_id AND b.deleted = 0)`;
});

const dropOrphanViews = Effect.fn("SpacesDatabaseSweep.dropOrphanViews")(function* (
  pick: ViewPick,
  nowMs: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  for (const view of pick.views) {
    const [current] = yield* sql<{
      readonly database_id: string;
    }>`SELECT v.database_id FROM spaces_db_views v WHERE v.view_id = ${view.id}
      AND v.orphaned_at_ms = ${view.mark} AND v.owner_block_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM spaces_blocks b WHERE b.block_id = v.owner_block_id AND b.deleted = 0)`;
    if (current === undefined) continue;
    if (!pick.complete || pick.listed.has(view.id)) {
      // Something live still lists it, so it is not an orphan: look again later.
      yield* sql`UPDATE spaces_db_views SET orphaned_at_ms = ${nowMs} WHERE view_id = ${view.id}`;
      continue;
    }
    yield* sql`DELETE FROM spaces_db_views WHERE view_id = ${view.id}`;
    yield* Ids.retire(view.id);
    yield* DatabaseStore.touchDatabase(current.database_id, isoNow(nowMs));
  }
});

const startPurge = Effect.fn("SpacesDatabaseSweep.startPurge")(function* (
  candidate: NonNullable<Survey["candidate"]>,
  nowMs: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const [current] = yield* sql<{
    readonly database_id: string;
  }>`SELECT d.database_id FROM spaces_db_databases d WHERE d.database_id = ${candidate.databaseId}
    AND d.purge_started_at_ms IS NULL AND d.orphaned_at_ms = ${candidate.mark}
    AND NOT EXISTS (SELECT 1 FROM spaces_blocks b WHERE b.block_id = d.home_block_id AND b.deleted = 0)`;
  if (current === undefined) return false;
  if (candidate.named) {
    // A live block names it: an adopter may still come back for it.
    yield* sql`UPDATE spaces_db_databases SET orphaned_at_ms = ${nowMs} WHERE database_id = ${candidate.databaseId}`;
    return false;
  }
  yield* sql`UPDATE spaces_db_databases SET purge_started_at_ms = ${nowMs} WHERE database_id = ${candidate.databaseId}`;
  yield* sql`UPDATE spaces_core SET catalog_revision = catalog_revision + 1 WHERE singleton = 1`;
  return true;
});

const removeRow = Effect.fn("SpacesDatabaseSweep.removeRow")(function* (
  environmentId: EnvironmentId,
  row: { readonly page_id: string; readonly trash_batch_id: string | null },
  nowMs: number,
) {
  const pageId = C.SpacePageId.make(row.page_id);
  const plan = (recovery: "trash" | "permanentlyDelete") =>
    PageStructure.plan({ environmentId, target: { kind: "page", pageId }, recovery }, 0);
  if (row.trash_batch_id === null)
    yield* finishRecovery(yield* plan("trash"), "trashPage", `sweep-trash-${row.page_id}`, nowMs);
  yield* finishRecovery(
    yield* plan("permanentlyDelete"),
    "permanentlyDeletePage",
    `sweep-delete-${row.page_id}`,
    nowMs,
  );
});

/** One bounded pass over a purging database: some rows, and the views once no row is left. */
const purgePass = Effect.fn("SpacesDatabaseSweep.purgePass")(function* (
  databaseId: string,
  environmentId: EnvironmentId,
  nowMs: number,
  skipped: Set<string>,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const rows = yield* sql<{
    readonly page_id: string;
    readonly trash_batch_id: string | null;
  }>`SELECT p.page_id, p.trash_batch_id FROM spaces_pages p
    JOIN spaces_db_data_sources s ON s.data_source_id = p.data_source_id
    WHERE s.database_id = ${databaseId} AND p.page_id NOT IN ${sql.in(idsIn(skipped))}
    ORDER BY p.page_id LIMIT ${deadDatabasePurgeRows}`;
  for (const row of rows) {
    const failed = yield* sql.withTransaction(removeRow(environmentId, row, nowMs)).pipe(
      Effect.as(undefined),
      Effect.catch((error) => Effect.succeed(error._tag)),
    );
    // A removal that reports success but leaves the page would be picked again for ever.
    const [remaining] = yield* sql`SELECT 1 FROM spaces_pages WHERE page_id = ${row.page_id}`;
    if (failed === undefined && remaining === undefined) continue;
    skipped.add(row.page_id);
    yield* Effect.logWarning(
      `Spaces could not remove a row of a deleted database (${failed ?? "page remains"}).`,
    );
  }
  const [left] = yield* sql`SELECT 1 FROM spaces_pages p
    JOIN spaces_db_data_sources s ON s.data_source_id = p.data_source_id
    WHERE s.database_id = ${databaseId} AND p.page_id NOT IN ${sql.in(idsIn(skipped))} LIMIT 1`;
  if (left !== undefined) return rows.length > 0;
  const views = yield* sql<{
    readonly view_id: string;
  }>`SELECT view_id FROM spaces_db_views WHERE database_id = ${databaseId}`;
  for (const view of views) yield* Ids.retire(view.view_id);
  yield* sql`DELETE FROM spaces_db_views WHERE database_id = ${databaseId}`;
  yield* sql`DELETE FROM spaces_db_computed_dirty WHERE data_source_id IN
    (SELECT data_source_id FROM spaces_db_data_sources WHERE database_id = ${databaseId})`;
  return rows.length > 0 || views.length > 0;
});

/**
 * The write half, run in one maintenance transaction. Everything the survey found is checked
 * again here, so a database revived between the two halves loses nothing. Returns whether a
 * purge made progress, which is when another pass is worth running at once.
 */
export const write = Effect.fn("SpacesDatabaseSweep.write")(function* (
  found: Survey,
  environmentId: EnvironmentId,
  nowMs: number,
  skipped: Set<string>,
) {
  yield* markAndClear(nowMs);
  if (found.views !== undefined) yield* dropOrphanViews(found.views, nowMs);
  let progressed = false;
  if (found.candidate !== undefined) progressed = yield* startPurge(found.candidate, nowMs);
  if (found.purging !== undefined)
    progressed = (yield* purgePass(found.purging, environmentId, nowMs, skipped)) || progressed;
  return progressed;
});
