import {
  SPACE_PAGE_SHARE_BLOCK_PARAM,
  SPACE_PAGE_SHARE_CURSOR_PARAM,
  SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE,
  SPACE_PAGE_SHARE_FROM_PARAM,
  SPACE_PAGE_SHARE_GROUP_PARAM,
  SPACE_PAGE_SHARE_PAGE_PARAM,
  SPACE_PAGE_SHARE_TO_PARAM,
  SPACE_PAGE_SHARE_VIEW_PARAM,
  SPACE_PAGE_SHARE_ZONE_PARAM,
  SpaceSharedDatabaseWindow,
  type SpaceSharedGroupBucket,
} from "@t2code/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";

import {
  appendBucket,
  appendRows,
  bucketId,
  continueOrRestart,
  fromWindow,
  type WindowData,
} from "./paging";
import { sharedGet, type Fetched, type Problem } from "./request";

const decodeWindow = Schema.decodeUnknownOption(Schema.toCodecJson(SpaceSharedDatabaseWindow));

export interface SharedQuery {
  readonly credential: string;
  /** The page that holds the database block; absent means the share root. */
  readonly pageId: string | undefined;
  readonly blockId: string;
  readonly viewId: string;
  readonly zone: string;
  /** Calendar and timeline only: the first and last day to cover. */
  readonly range?: { readonly from: string; readonly to: string };
}

export type SharedWindowState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly problem: Problem }
  | {
      readonly status: "ready";
      readonly data: WindowData;
      /** `rows`, a bucket id, or null. */
      readonly busy: string | null;
      readonly moreProblem: Problem | null;
    };

function fetchWindow(
  query: SharedQuery,
  extra: { readonly group?: string; readonly cursor?: string },
  signal: AbortSignal,
): Promise<Fetched<SpaceSharedDatabaseWindow>> {
  return sharedGet(
    SPACE_PAGE_SHARE_DATABASE_QUERY_ROUTE,
    {
      [SPACE_PAGE_SHARE_PAGE_PARAM]: query.pageId,
      [SPACE_PAGE_SHARE_BLOCK_PARAM]: query.blockId,
      [SPACE_PAGE_SHARE_VIEW_PARAM]: query.viewId,
      [SPACE_PAGE_SHARE_ZONE_PARAM]: query.zone,
      [SPACE_PAGE_SHARE_FROM_PARAM]: query.range?.from,
      [SPACE_PAGE_SHARE_TO_PARAM]: query.range?.to,
      [SPACE_PAGE_SHARE_GROUP_PARAM]: extra.group,
      [SPACE_PAGE_SHARE_CURSOR_PARAM]: extra.cursor,
    },
    query.credential,
    decodeWindow,
    signal,
  );
}

const queryKey = (query: SharedQuery) =>
  [
    query.credential,
    query.pageId ?? "",
    query.blockId,
    query.viewId,
    query.zone,
    query.range?.from ?? "",
    query.range?.to ?? "",
  ].join("\n");

/**
 * One view's rows, loaded window by window. A new view or range aborts the old walk. No timers:
 * the next window loads only when the viewer asks for it.
 */
export function useSharedWindow(query: SharedQuery) {
  const key = queryKey(query);
  const { credential, pageId, blockId, viewId, zone } = query;
  const from = query.range?.from;
  const to = query.range?.to;
  const [loaded, setLoaded] = useState<{ key: string; state: SharedWindowState } | null>(null);
  const controller = useRef<AbortController | null>(null);

  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Fetches the first window from the network whenever the view or date range changes.
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    const first: SharedQuery = {
      credential,
      pageId,
      blockId,
      viewId,
      zone,
      ...(from === undefined || to === undefined ? {} : { range: { from, to } }),
    };
    void fetchWindow(first, {}, abort.signal).then((result) => {
      if (abort.signal.aborted) return;
      setLoaded({
        key,
        state: result.ok
          ? { status: "ready", data: fromWindow(result.value), busy: null, moreProblem: null }
          : { status: "failed", problem: result.problem },
      });
    });
    return () => abort.abort();
  }, [key, credential, pageId, blockId, viewId, zone, from, to]);

  const state: SharedWindowState = loaded?.key === key ? loaded.state : { status: "loading" };

  const update = (signal: AbortSignal, next: (current: SharedWindowState) => SharedWindowState) => {
    if (signal.aborted) return;
    setLoaded((current) => (current?.key === key ? { key, state: next(current.state) } : current));
  };

  const run = (id: string, group: string | undefined, cursor: string, bucket: boolean) => {
    const signal = controller.current?.signal;
    if (signal === undefined || state.status !== "ready" || state.busy !== null) return;
    update(signal, (current) =>
      current.status === "ready" ? { ...current, busy: id, moreProblem: null } : current,
    );
    void continueOrRestart(
      () => fetchWindow(query, { ...(group === undefined ? {} : { group }), cursor }, signal),
      () => fetchWindow(query, {}, signal),
    ).then((result) => {
      update(signal, (current) => {
        if (current.status !== "ready") return current;
        if (result.kind === "failed")
          return { ...current, busy: null, moreProblem: result.problem };
        if (result.kind === "restarted")
          return { status: "ready", data: fromWindow(result.value), busy: null, moreProblem: null };
        return {
          ...current,
          busy: null,
          data: bucket
            ? appendBucket(current.data, id, result.value)
            : appendRows(current.data, result.value),
        };
      });
    });
  };

  return {
    state,
    loadMore: () => {
      if (state.status === "ready" && state.data.nextCursor !== null)
        run("rows", undefined, state.data.nextCursor, false);
    },
    loadBucket: (bucket: SpaceSharedGroupBucket) => {
      if (bucket.nextCursor !== null)
        run(bucketId(bucket), JSON.stringify(bucket.key), bucket.nextCursor, true);
    },
  };
}
