import type {
  SpaceCursor,
  SpaceDatabaseQueryInput,
  SpaceDatabaseQueryResult,
  SpaceDatabaseRow,
  SpaceGroupBucket,
} from "@t2code/contracts/spaces";
import { canonicalJson } from "./queryKey.ts";

/**
 * Windows of one query share a key across modes, window sizes and bucket continuations, so a
 * bucket's follow-up read lands in the groups state it continues.
 */
function windowKey(input: SpaceDatabaseQueryInput): string {
  const {
    cursor: _cursor,
    mode: _mode,
    limit: _limit,
    rowsPerGroup: _rows,
    scope,
    ...rest
  } = input;
  return canonicalJson({
    ...rest,
    ...(scope?.parentRowId === undefined ? {} : { parentRowId: scope.parentRowId }),
  });
}

/** Everything loaded so far for one query, grown window by window. */
export interface QueryWindows {
  readonly key: string;
  readonly rows: ReadonlyArray<SpaceDatabaseRow>;
  /** Cursor of the next top-level window; null once the last window arrived. */
  readonly nextCursor: SpaceCursor | null;
  readonly groups: ReadonlyArray<SpaceGroupBucket> | undefined;
  readonly groupsTruncated: boolean;
  readonly total: number | undefined;
  readonly schemaRevision: number;
  readonly dataRevision: number;
  /**
   * Set when a later window saw a newer data revision than the first. Cursors stay valid across
   * edits, but windows loaded earlier may be out of date, so the view should refetch from the top.
   */
  readonly outdated: boolean;
}

const mergeRows = (
  existing: ReadonlyArray<SpaceDatabaseRow>,
  incoming: ReadonlyArray<SpaceDatabaseRow>,
) => {
  if (incoming.length === 0) return existing;
  const incomingIds = new Set(incoming.map((row) => row.page.id));
  const replaced = existing.map((row) =>
    incomingIds.has(row.page.id) ? incoming.find((entry) => entry.page.id === row.page.id)! : row,
  );
  const known = new Set(existing.map((row) => row.page.id));
  return [...replaced, ...incoming.filter((row) => !known.has(row.page.id))];
};

/** Starts a query from its first result. */
export function startWindows(
  input: SpaceDatabaseQueryInput,
  result: SpaceDatabaseQueryResult,
): QueryWindows {
  return {
    key: windowKey(input),
    rows: result.rows,
    nextCursor: result.nextCursor,
    groups: result.groups,
    groupsTruncated: result.groupsTruncated === true,
    total: result.total,
    schemaRevision: result.schemaRevision,
    dataRevision: result.dataRevision,
    outdated: false,
  };
}

/**
 * Folds a later window into the loaded state. A window for a different query, or one that
 * continues a bucket that is not loaded, is ignored. In groups mode the result replaces the buckets.
 */
export function appendWindow(
  state: QueryWindows,
  input: SpaceDatabaseQueryInput,
  result: SpaceDatabaseQueryResult,
): QueryWindows {
  if (windowKey(input) !== state.key) return state;
  const outdated =
    state.outdated ||
    result.schemaRevision !== state.schemaRevision ||
    result.dataRevision !== state.dataRevision;
  const base = {
    ...state,
    schemaRevision: result.schemaRevision,
    dataRevision: result.dataRevision,
    total: result.total ?? state.total,
    outdated,
  };
  if (input.mode === "groups") {
    return { ...base, groups: result.groups, groupsTruncated: result.groupsTruncated === true };
  }
  const scope = input.scope;
  if (scope?.group === undefined) {
    return { ...base, rows: mergeRows(state.rows, result.rows), nextCursor: result.nextCursor };
  }
  const group = canonicalJson(scope.group);
  const subGroup = scope.subGroup === undefined ? undefined : canonicalJson(scope.subGroup);
  const grow = <B extends Pick<SpaceGroupBucket, "rows" | "nextCursor">>(bucket: B): B => ({
    ...bucket,
    rows: mergeRows(bucket.rows, result.rows),
    nextCursor: result.nextCursor,
  });
  const groups = state.groups?.map((bucket) => {
    if (canonicalJson(bucket.key) !== group) return bucket;
    if (subGroup === undefined) return grow(bucket);
    if (bucket.subGroups === undefined) return bucket;
    return {
      ...bucket,
      subGroups: bucket.subGroups.map((sub) =>
        canonicalJson(sub.key) === subGroup ? grow(sub) : sub,
      ),
    };
  });
  return { ...base, groups };
}
