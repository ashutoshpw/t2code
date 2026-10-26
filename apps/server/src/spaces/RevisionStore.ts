import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import type { BlockRow } from "./BlockStore.ts";
import { canonical, historyLimits as limits, limits as coreLimits } from "./CorePolicy.ts";
import * as SpacesSql from "./SpacesSql.ts";

export interface PagePreimage {
  readonly pageId: string;
  readonly spaceId: string;
  readonly title: string;
  readonly revision: number;
  readonly rootOrder: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RevisionRow {
  readonly page_id: string;
  readonly to_revision: number;
  readonly expires_at_ms: number;
  readonly logical_bytes: number;
  readonly asset_count: number;
}

const budget = () => ({ rows: 0, bytes: 0 });
function reserve(used: ReturnType<typeof budget>, row: RevisionRow) {
  if (
    used.rows + 1 + row.asset_count > limits.cleanupBatchRows ||
    used.bytes + row.logical_bytes > limits.cleanupBatchBytes
  )
    return false;
  used.rows += 1 + row.asset_count;
  used.bytes += row.logical_bytes;
  return true;
}

const remove = Effect.fn("SpacesRevisions.remove")(function* (rows: readonly RevisionRow[]) {
  const sql = yield* SpacesSql.SpacesSql;
  for (const row of rows) {
    yield* sql`DELETE FROM spaces_revisions WHERE page_id = ${row.page_id} AND to_revision = ${row.to_revision}`;
    yield* sql`UPDATE spaces_pages SET retained_revision_count = retained_revision_count - 1,
      retained_revision_bytes = retained_revision_bytes - ${row.logical_bytes} WHERE page_id = ${row.page_id}`;
  }
  if (rows.length)
    yield* sql`UPDATE spaces_core SET revision_bytes = revision_bytes - ${rows.reduce((sum, row) => sum + row.logical_bytes, 0)} WHERE singleton = 1`;
});

export const prune = Effect.fn("SpacesRevisions.prune")(function* (now: number) {
  const sql = yield* SpacesSql.SpacesSql;
  const expired =
    yield* sql<RevisionRow>`SELECT page_id, to_revision, expires_at_ms, logical_bytes, asset_count
    FROM spaces_revisions WHERE expires_at_ms <= ${now}
    ORDER BY expires_at_ms, page_id, to_revision LIMIT ${limits.cleanupBatchRows}`;
  const used = budget();
  const selected: RevisionRow[] = [];
  for (const row of expired) {
    if (!reserve(used, row)) break;
    selected.push(row);
  }
  yield* remove(selected);
});

function capacity(pageBytes: number, environmentBytes?: number): never {
  if (pageBytes > limits.maxPageBytes)
    throw new C.SpaceLimitExceededError({
      limit: "history.maxPageBytes",
      actual: pageBytes,
      maximum: limits.maxPageBytes,
    });
  if (environmentBytes !== undefined && environmentBytes > limits.maxEnvironmentBytes)
    throw new C.SpaceLimitExceededError({
      limit: "history.maxEnvironmentBytes",
      actual: environmentBytes,
      maximum: limits.maxEnvironmentBytes,
    });
  throw new C.SpacesUnavailableError({ stage: "capacity" });
}

export const capture = Effect.fn("SpacesRevisions.capture")(function* (
  input: {
    readonly pageId: string;
    readonly toRevision: number;
    readonly mutationId: string;
    readonly pageBefore: PagePreimage | null;
    readonly blocksBefore: readonly { readonly id: string; readonly row: BlockRow | null }[];
  },
  now: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const beforeIds = input.blocksBefore
    .filter((block) => block.row !== null)
    .map((block) => block.id);
  const assets = beforeIds.length
    ? yield* sql<{
        readonly asset_id: string;
      }>`SELECT DISTINCT asset_id FROM spaces_block_asset_refs
        WHERE block_id IN ${sql.in(beforeIds)} ORDER BY asset_id LIMIT ${limits.cleanupBatchRows}`
    : [];
  const assetIds = assets.map((asset) => asset.asset_id).sort();
  // Every accepted complete record must fit a later cleanup pass, including its pin rows.
  if (
    assetIds.length + 1 > limits.cleanupBatchRows ||
    assetIds.length > coreLimits.maxMutationNodes
  )
    return yield* new C.SpacesUnavailableError({ stage: "capacity" });
  const payload = canonical(
    {
      version: 1,
      pageBefore: input.pageBefore,
      ownerBefore: null,
      blocksBefore: input.blocksBefore,
    },
    limits.maxDeltaBytes,
    "history.maxDeltaBytes",
  );
  const expiresAtMs = now + limits.retentionMs;
  const record = canonical(
    {
      pageId: input.pageId,
      toRevision: input.toRevision,
      mutationId: input.mutationId,
      createdAtMs: now,
      expiresAtMs,
      payload,
      assetIds,
    },
    limits.maxDeltaBytes,
    "history.maxDeltaBytes",
  );
  const bytes = Buffer.byteLength(record, "utf8");
  if (bytes > limits.cleanupBatchBytes)
    return yield* new C.SpacesUnavailableError({ stage: "capacity" });
  const [page] = yield* sql<{
    readonly retained_revision_count: number;
    readonly retained_revision_bytes: number;
  }>`
    SELECT retained_revision_count, retained_revision_bytes FROM spaces_pages WHERE page_id = ${input.pageId}`;
  if (!page) return yield* new C.SpacesUnavailableError({ stage: "storage" });
  let count = page.retained_revision_count + 1;
  let pageBytes = page.retained_revision_bytes + bytes;
  const used = budget();
  const pageRows =
    yield* sql<RevisionRow>`SELECT page_id, to_revision, expires_at_ms, logical_bytes, asset_count
    FROM spaces_revisions WHERE page_id = ${input.pageId} ORDER BY to_revision LIMIT ${limits.cleanupBatchRows}`;
  const selected: RevisionRow[] = [];
  for (const row of pageRows) {
    if (
      row.expires_at_ms > now &&
      count <= limits.maxRevisionsPerPage &&
      pageBytes <= limits.maxPageBytes
    )
      continue;
    if (!reserve(used, row)) capacity(pageBytes);
    selected.push(row);
    count--;
    pageBytes -= row.logical_bytes;
  }
  if (count > limits.maxRevisionsPerPage || pageBytes > limits.maxPageBytes) capacity(pageBytes);
  yield* remove(selected);
  const [meta] = yield* sql<{
    readonly revision_bytes: number;
  }>`SELECT revision_bytes FROM spaces_core WHERE singleton = 1`;
  if (!meta) return yield* new C.SpacesUnavailableError({ stage: "storage" });
  let environmentBytes = meta.revision_bytes + bytes;
  if (environmentBytes > limits.maxEnvironmentBytes) {
    const oldest =
      yield* sql<RevisionRow>`SELECT page_id, to_revision, expires_at_ms, logical_bytes, asset_count
      FROM spaces_revisions ORDER BY created_at_ms, page_id, to_revision LIMIT ${limits.cleanupBatchRows - used.rows}`;
    const evicted: RevisionRow[] = [];
    for (const row of oldest) {
      if (environmentBytes <= limits.maxEnvironmentBytes) break;
      if (!reserve(used, row)) capacity(pageBytes, environmentBytes);
      evicted.push(row);
      environmentBytes -= row.logical_bytes;
    }
    if (environmentBytes > limits.maxEnvironmentBytes) capacity(pageBytes, environmentBytes);
    yield* remove(evicted);
  }
  yield* sql`INSERT INTO spaces_revisions (page_id, to_revision, mutation_id, created_at_ms, expires_at_ms, payload, logical_bytes, asset_count)
    VALUES (${input.pageId}, ${input.toRevision}, ${input.mutationId}, ${now}, ${expiresAtMs}, ${payload}, ${bytes}, ${assetIds.length})`;
  for (const assetId of assetIds)
    yield* sql`INSERT INTO spaces_revision_asset_refs (page_id, to_revision, asset_id)
    VALUES (${input.pageId}, ${input.toRevision}, ${assetId})`;
  yield* sql`UPDATE spaces_pages SET retained_revision_count = retained_revision_count + 1,
    retained_revision_bytes = retained_revision_bytes + ${bytes} WHERE page_id = ${input.pageId}`;
  yield* sql`UPDATE spaces_core SET revision_bytes = revision_bytes + ${bytes} WHERE singleton = 1`;
});
