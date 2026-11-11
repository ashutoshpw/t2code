import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { limits } from "../CorePolicy.ts";
import * as SpacesSql from "../SpacesSql.ts";
import { trashed } from "./Types.ts";

interface Hop {
  readonly trash_batch_id: string | null;
  readonly root_order: string | null;
  readonly data_source_id: string | null;
  readonly owner_block_id: string | null;
  readonly owner_page_id: string | null;
  readonly owner_deleted: number | null;
}
interface Home {
  readonly database_id: string;
  readonly home_page_id: string | null;
  readonly home_deleted: number | null;
}

/**
 * The single authority on whether a page is reachable. A page is live when it and every page on
 * its container-parent chain are untrashed and every connecting block exists. `databases` lists
 * the databases the walk passed through, whether or not their home block is still there.
 */
const walk = Effect.fn("SpacesDatabases.walk")(function* (pageId: string) {
  const sql = yield* SpacesSql.SpacesSql;
  const databases: string[] = [];
  let current = pageId;
  for (let hop = 0; hop <= 2 * limits.maxDepth; hop++) {
    const [row] =
      yield* sql<Hop>`SELECT p.trash_batch_id, p.root_order, p.data_source_id, o.owner_block_id,
      b.page_id AS owner_page_id, b.deleted AS owner_deleted
      FROM spaces_pages p LEFT JOIN spaces_page_owners o ON o.child_page_id = p.page_id
      LEFT JOIN spaces_blocks b ON b.block_id = o.owner_block_id WHERE p.page_id = ${current}`;
    if (!row || row.trash_batch_id !== null) return { live: false, databases };
    if (row.owner_block_id !== null) {
      if (row.owner_deleted !== 0 || row.owner_page_id === null) return { live: false, databases };
      current = row.owner_page_id;
    } else if (row.data_source_id !== null) {
      const [home] =
        yield* sql<Home>`SELECT d.database_id, hb.page_id AS home_page_id, hb.deleted AS home_deleted
        FROM spaces_db_data_sources s JOIN spaces_db_databases d ON d.database_id = s.database_id
        LEFT JOIN spaces_blocks hb ON hb.block_id = d.home_block_id WHERE s.data_source_id = ${row.data_source_id}`;
      if (!home) return { live: false, databases };
      databases.push(home.database_id);
      if (home.home_deleted !== 0 || home.home_page_id === null) return { live: false, databases };
      current = home.home_page_id;
    } else return { live: row.root_order !== null, databases };
  }
  return { live: false, databases };
});

export const pageLive = Effect.fn("SpacesDatabases.pageLive")(function* (pageId: string) {
  return (yield* walk(pageId)).live;
});

/** A page inside a database (a row or something under one) whose database is no longer live. */
export const insideDeadDatabase = Effect.fn("SpacesDatabases.insideDeadDatabase")(function* (
  pageId: string,
) {
  const { live, databases } = yield* walk(pageId);
  return databases.length > 0 && !live;
});

/** The databases a page sits inside, nearest first. */
export const chain = Effect.fn("SpacesDatabases.chain")(function* (pageId: string) {
  return (yield* walk(pageId)).databases;
});

export const assertPageLive = Effect.fn("SpacesDatabases.assertPageLive")(function* (
  pageId: string,
) {
  if (!(yield* pageLive(pageId))) return yield* trashed();
});

export const databaseLive = Effect.fn("SpacesDatabases.databaseLive")(function* (
  databaseId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const [home] = yield* sql<{
    readonly page_id: string;
  }>`SELECT b.page_id FROM spaces_db_databases d JOIN spaces_blocks b ON b.block_id = d.home_block_id
    WHERE d.database_id = ${databaseId} AND b.deleted = 0`;
  return home !== undefined && (yield* pageLive(home.page_id));
});

export const assertDatabaseLive = Effect.fn("SpacesDatabases.assertDatabaseLive")(function* (
  databaseId: C.SpaceDatabaseId | string,
) {
  if (!(yield* databaseLive(databaseId))) return yield* trashed();
});
