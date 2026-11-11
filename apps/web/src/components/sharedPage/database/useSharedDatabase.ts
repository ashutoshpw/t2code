import {
  SPACE_PAGE_SHARE_BLOCK_PARAM,
  SPACE_PAGE_SHARE_DATABASE_ROUTE,
  SPACE_PAGE_SHARE_PAGE_PARAM,
  SpaceSharedDatabase,
} from "@t2code/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { sharedGet, type Fetched } from "./request";

const decodeDatabase = Schema.decodeUnknownOption(Schema.toCodecJson(SpaceSharedDatabase));

export function fetchSharedDatabase(
  credential: string,
  pageId: string | undefined,
  blockId: string,
  signal: AbortSignal,
) {
  return sharedGet(
    SPACE_PAGE_SHARE_DATABASE_ROUTE,
    { [SPACE_PAGE_SHARE_PAGE_PARAM]: pageId, [SPACE_PAGE_SHARE_BLOCK_PARAM]: blockId },
    credential,
    decodeDatabase,
    signal,
  );
}

/** The database's saved views and schema; null while loading. */
export function useSharedDatabase(
  credential: string,
  pageId: string | undefined,
  blockId: string,
): Fetched<SpaceSharedDatabase> | null {
  const key = `${credential}\n${pageId ?? ""}\n${blockId}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: Fetched<SpaceSharedDatabase>;
  } | null>(null);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Fetches the database description from the network whenever the link, page or block changes.
  useEffect(() => {
    const abort = new AbortController();
    void fetchSharedDatabase(credential, pageId, blockId, abort.signal).then((result) => {
      if (!abort.signal.aborted) setLoaded({ key, result });
    });
    return () => abort.abort();
  }, [key, credential, pageId, blockId]);
  return loaded?.key === key ? loaded.result : null;
}
