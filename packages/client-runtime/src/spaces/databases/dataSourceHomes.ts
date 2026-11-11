import type { SpaceCursor, SpaceDatabaseListResult } from "@t2code/contracts/spaces";

type ListPage = Pick<SpaceDatabaseListResult, "items" | "nextCursor">;

export interface DataSourceHome {
  readonly databaseId: string;
  readonly title: string;
}

export interface DataSourceHomes {
  readonly homes: ReadonlyMap<string, DataSourceHome>;
  /** Ids that no listed database owns, after every bounded page was read. */
  readonly missing: ReadonlyArray<string>;
  /** A page read failed or the page cap was reached: a missing id is unknown, not deleted. */
  readonly incomplete: boolean;
}

const MAX_PAGES = 20;

/** Where each data source lives, from list pages already read and then more pages as needed. */
export function findDataSourceHomes(input: {
  readonly ids: ReadonlyArray<string>;
  readonly first: ListPage | null;
  /** Reads one page of the home space's databases, or of every space when `anySpace`. */
  readonly listPage: (cursor: SpaceCursor | undefined, anySpace: boolean) => Promise<ListPage>;
}): Promise<DataSourceHomes> {
  return (async () => {
    const homes = new Map<string, DataSourceHome>();
    const wanted = new Set(input.ids);
    const scan = (page: ListPage) => {
      for (const item of page.items)
        for (const source of item.dataSources)
          if (wanted.has(source.id) && !homes.has(source.id))
            homes.set(source.id, {
              databaseId: item.database.id,
              title: item.database.title.trim() || "Untitled",
            });
    };
    let incomplete = false;
    const walk = async (start: ListPage | null, anySpace: boolean) => {
      let page = start;
      try {
        for (let read = 0; read < MAX_PAGES && homes.size < wanted.size; read += 1) {
          if (page === null) page = await input.listPage(undefined, anySpace);
          else if (page.nextCursor === null) return;
          else page = await input.listPage(page.nextCursor, anySpace);
          scan(page);
        }
        if (homes.size < wanted.size && page?.nextCursor != null) incomplete = true;
      } catch {
        incomplete = true;
      }
    };
    if (input.first !== null) scan(input.first);
    await walk(input.first, false);
    if (homes.size < wanted.size && !incomplete) await walk(null, true);
    return { homes, missing: input.ids.filter((id) => !homes.has(id)), incomplete };
  })();
}
