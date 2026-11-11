import type {
  SpaceSharedDatabaseRow,
  SpaceSharedDatabaseRowPage,
  SpaceSharedDatabaseWindow,
  SpaceSharedGroupBucket,
  SpaceSharedOption,
} from "@t2code/contracts";
import type { SpaceRelatedPage } from "@t2code/contracts/spaces";

import type { Fetched, Problem } from "./request";

/** Rows kept per flat view and per bucket; past it the viewer stops offering more. */
export const MAX_ROWS = 500;
export const MAX_BUCKET_ROWS = 200;
/** Times a refused cursor may restart the walk of a row body. */
export const MAX_WINDOW_RESTARTS = 3;

type Options = Readonly<Record<string, ReadonlyArray<SpaceSharedOption>>>;
type Related = Readonly<Record<string, SpaceRelatedPage>>;

export interface WindowData {
  readonly rows: ReadonlyArray<SpaceSharedDatabaseRow>;
  readonly groups: ReadonlyArray<SpaceSharedGroupBucket> | null;
  readonly groupsTruncated: boolean;
  readonly options: Options;
  readonly relatedPages: Related;
  readonly nextCursor: string | null;
}

export const bucketId = (bucket: Pick<SpaceSharedGroupBucket, "key">) => JSON.stringify(bucket.key);

export function fromWindow(window: SpaceSharedDatabaseWindow): WindowData {
  return {
    rows: window.rows,
    groups: window.groups ?? null,
    groupsTruncated: window.groupsTruncated === true,
    options: window.options,
    relatedPages: window.relatedPages,
    nextCursor: window.nextCursor,
  };
}

function mergeOptions(base: Options, more: Options): Options {
  const keys = Object.keys(more);
  if (keys.length === 0) return base;
  const merged: Record<string, ReadonlyArray<SpaceSharedOption>> = { ...base };
  for (const key of keys) {
    const known = merged[key] ?? [];
    const seen = new Set(known.map((option) => option.id));
    const added = (more[key] ?? []).filter((option) => !seen.has(option.id));
    merged[key] = added.length === 0 ? known : [...known, ...added];
  }
  return merged;
}

function mergeRelated(base: Related, more: Related): Related {
  return Object.keys(more).length === 0 ? base : { ...base, ...more };
}

function appendUnique(
  rows: ReadonlyArray<SpaceSharedDatabaseRow>,
  more: ReadonlyArray<SpaceSharedDatabaseRow>,
) {
  const seen = new Set(rows.map((row) => row.id));
  return [...rows, ...more.filter((row) => !seen.has(row.id))];
}

/** A continuation of the flat row list. */
export function appendRows(data: WindowData, window: SpaceSharedDatabaseWindow): WindowData {
  return {
    ...data,
    rows: appendUnique(data.rows, window.rows),
    options: mergeOptions(data.options, window.options),
    relatedPages: mergeRelated(data.relatedPages, window.relatedPages),
    nextCursor: window.nextCursor,
  };
}

/** A continuation of one bucket; the bucket count stays the server's. */
export function appendBucket(
  data: WindowData,
  id: string,
  window: SpaceSharedDatabaseWindow,
): WindowData {
  return {
    ...data,
    groups:
      data.groups?.map((bucket) =>
        bucketId(bucket) === id
          ? {
              ...bucket,
              rows: appendUnique(bucket.rows, window.rows),
              nextCursor: window.nextCursor,
            }
          : bucket,
      ) ?? null,
    options: mergeOptions(data.options, window.options),
    relatedPages: mergeRelated(data.relatedPages, window.relatedPages),
  };
}

export type Continued<A> =
  | { readonly kind: "more" | "restarted"; readonly value: A }
  | { readonly kind: "failed"; readonly problem: Problem };

/** The server refuses a cursor once the data moved; start over from the first window. */
export async function continueOrRestart<A>(
  next: () => Promise<Fetched<A>>,
  first: () => Promise<Fetched<A>>,
): Promise<Continued<A>> {
  const more = await next();
  if (more.ok) return { kind: "more", value: more.value };
  if (more.problem !== "unavailable") return { kind: "failed", problem: more.problem };
  const restarted = await first();
  return restarted.ok
    ? { kind: "restarted", value: restarted.value }
    : { kind: "failed", problem: restarted.problem };
}

/** Walks every window of a row's body, restarting on a refused cursor like the page loader. */
export async function walkRowBody(
  fetchRow: (cursor: string | undefined) => Promise<Fetched<SpaceSharedDatabaseRowPage>>,
): Promise<Fetched<SpaceSharedDatabaseRowPage>> {
  let page: SpaceSharedDatabaseRowPage | undefined;
  let cursor: string | undefined;
  let restarts = 0;
  for (;;) {
    const result = await fetchRow(cursor);
    if (!result.ok) {
      if (
        result.problem === "unavailable" &&
        cursor !== undefined &&
        restarts++ < MAX_WINDOW_RESTARTS
      ) {
        page = undefined;
        cursor = undefined;
        continue;
      }
      return result;
    }
    const next = result.value;
    page = page
      ? {
          ...page,
          window: { ...page.window, blocks: [...page.window.blocks, ...next.window.blocks] },
        }
      : next;
    cursor = next.nextCursor;
    if (cursor === undefined) return { ok: true, value: page };
  }
}
