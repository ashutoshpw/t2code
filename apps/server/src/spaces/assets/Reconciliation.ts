import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { canonical, historyLimits, limits } from "../CorePolicy.ts";
import * as SpacesSql from "../SpacesSql.ts";

export interface State {
  readonly format_version: number;
  readonly block_cursor: string;
  readonly blocks_done: number;
  readonly history_page: string;
  readonly history_revision: number;
  readonly history_done: number;
  readonly blob_cursor: string;
  readonly blobs_done: number;
  readonly file_kind: string;
  readonly file_cursor: string;
  readonly assets_done: number;
  readonly staging_done: number;
  readonly assets_generation: number;
  readonly staging_generation: number;
  readonly assets_bytes: number;
  readonly staging_bytes: number;
  readonly observed_at_ms: number;
  readonly cycle_started_ms: number;
}
export const state = Effect.fn("SpacesReconciliation.state")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<State>`SELECT * FROM spaces_asset_reconciliation WHERE singleton = 1`;
  if (!row) return yield* new C.SpacesUnavailableError({ stage: "storage" });
  return row;
});
export const initialize = Effect.fn("SpacesReconciliation.initialize")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  const current = yield* state();
  if (current.format_version > 3) return yield* new C.SpacesUnavailableError({ stage: "storage" });
  if (current.format_version < 3)
    yield* sql`UPDATE spaces_asset_reconciliation SET format_version = 3,
      block_cursor = '',blocks_done = 0,history_page = '',history_revision = -1,history_done = 0 WHERE singleton = 1`;
});
export const issue = Effect.fn("SpacesReconciliation.issue")(function* (
  kind: string,
  entity: string,
  reason: string | null,
) {
  const sql = yield* SpacesSql.SpacesSql;
  if (reason === null)
    yield* sql`DELETE FROM spaces_asset_reconciliation_issues WHERE kind = ${kind} AND entity = ${entity}`;
  else
    yield* sql`INSERT INTO spaces_asset_reconciliation_issues(kind,entity,reason) VALUES (${kind},${entity},${reason})
    ON CONFLICT(kind,entity) DO UPDATE SET reason = excluded.reason`;
});
const known = Schema.decodeUnknownOption(C.SpaceKnownBlock, { onExcessProperty: "error" });
const raw = Schema.decodeUnknownOption(Schema.fromJsonString(C.SpaceBlock));
const tombstone = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: C.SpaceBlockId,
      pageId: C.SpacePageId,
      mergedInto: Schema.NullOr(C.SpaceBlockId),
    }),
  ),
  { onExcessProperty: "error" },
);
const normalizedChild = Schema.decodeUnknownOption(
  Schema.Struct({
    id: C.SpaceBlockId,
    parentId: Schema.NullOr(C.SpaceBlockId),
    order: Schema.String,
    type: Schema.Literal("child_page"),
    version: Schema.Literal(1),
    content: Schema.Struct({}),
  }),
  { onExcessProperty: "error" },
);
const strictMark = Schema.decodeUnknownOption(C.SpaceKnownMark, { onExcessProperty: "error" });
function references(payload: string) {
  if (Buffer.byteLength(payload) > limits.maxBlockBytes) return { assetId: null, unresolved: true };
  try {
    const value = Option.getOrNull(raw(payload));
    if (value && Option.isSome(normalizedChild(value))) return { assetId: null, unresolved: false };
    const block = value && Option.getOrNull(known(value));
    if (!block) return { assetId: null, unresolved: true };
    const runs =
      "runs" in block.content
        ? block.content.runs
        : "caption" in block.content
          ? block.content.caption
          : [];
    const unresolved = (runs ?? []).some(
      (run) =>
        Object.keys(run).some((key) => key !== "text" && key !== "marks") ||
        run.marks.some((mark) => {
          if (Option.isNone(strictMark(mark))) return true;
          const allowed =
            mark.type === "link"
              ? ["type", "version", "href"]
              : mark.type === "page_mention" || mark.type === "block_mention"
                ? ["type", "version", "target"]
                : ["type", "version"];
          return Object.keys(mark).some((key) => !allowed.includes(key));
        }),
    );
    return { assetId: "assetId" in block.content ? block.content.assetId : null, unresolved };
  } catch {
    return { assetId: null, unresolved: true };
  }
}
export const noteBlock = Effect.fn("SpacesReconciliation.noteBlock")(function* (
  id: string,
  payload: string | null,
) {
  if (payload === null) yield* issue("block", id, null);
  // Shape-only write hooks cannot clear pin or readiness findings; reconciliation proves those.
  else if (references(payload).unresolved) yield* issue("block", id, "unknown_payload");
});
const Row = Schema.Struct({
  block_id: Schema.String,
  page_id: Schema.String,
  parent_id: Schema.NullOr(Schema.String),
  rank: Schema.String,
  payload: Schema.String,
  logical_bytes: Schema.Int,
  deleted: Schema.Literals([0, 1]),
  merged_into: Schema.NullOr(Schema.String),
});
const Page = Schema.Struct({
  pageId: Schema.String,
  spaceId: Schema.String,
  title: Schema.String,
  revision: Schema.Int,
  rootOrder: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const before = {
  pageBefore: Schema.NullOr(Page),
  blocksBefore: Schema.Array(Schema.Struct({ id: Schema.String, row: Schema.NullOr(Row) })),
};
const Owner = Schema.NullOr(
  Schema.Struct({ childPageId: Schema.String, ownerBlockId: Schema.String }),
);
const Preimage = Schema.Union([
  Schema.Struct({
    ...before,
    version: Schema.Literals([1, 2]),
    ownerBefore: Schema.optionalKey(Owner),
  }),
  Schema.Struct({
    ...before,
    version: Schema.Literal(3),
    ownerBefore: Owner,
    trashBefore: Schema.NullOr(
      Schema.Struct({
        batchId: Schema.String,
        rootPageId: Schema.String,
        trashedAtMs: Schema.Int,
        origin: Schema.String,
      }),
    ),
  }),
]);
const decodePreimage = Schema.decodeUnknownOption(Schema.fromJsonString(Preimage), {
  onExcessProperty: "error",
});
function historical(payload: string) {
  if (Buffer.byteLength(payload) > historyLimits.maxDeltaBytes)
    return { assets: [], unresolved: true };
  try {
    const value = Option.getOrNull(decodePreimage(payload));
    if (!value || value.blocksBefore.length > limits.maxMutationNodes)
      return { assets: [], unresolved: true };
    const assets = new Set<string>();
    let unresolved = false;
    for (const block of value.blocksBefore) {
      if (!block.row) continue;
      if (block.row.block_id !== block.id) {
        unresolved = true;
        continue;
      }
      if (block.row.deleted) {
        const deleted = Option.getOrNull(tombstone(block.row.payload));
        unresolved ||=
          !deleted ||
          deleted.id !== block.id ||
          deleted.pageId !== block.row.page_id ||
          deleted.mergedInto !== block.row.merged_into;
        continue;
      }
      const ref = references(block.row.payload);
      unresolved ||= ref.unresolved;
      if (ref.assetId !== null) assets.add(ref.assetId);
    }
    return { assets: [...assets].sort(), unresolved };
  } catch {
    return { assets: [], unresolved: true };
  }
}
const key = (page: string, revision: number) => canonical([page, revision]);
export const noteRevision = Effect.fn("SpacesReconciliation.noteRevision")(function* (
  page: string,
  revision: number,
  payload: string,
) {
  yield* issue(
    "history",
    key(page, revision),
    historical(payload).unresolved ? "unknown_payload" : null,
  );
});
export const status = Effect.fn("SpacesReconciliation.status")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  const current = yield* state();
  const unresolved =
    (yield* sql`SELECT 1 FROM spaces_asset_reconciliation_issues LIMIT 1`).length > 0;
  return {
    currentPending: !current.blocks_done,
    historyPending: !current.history_done,
    catalogPending: !current.blobs_done,
    inventoryPending: !current.assets_done || !current.staging_done,
    unresolved,
    gcEnabled: false as const,
  };
});
export const referencesPass = Effect.fn("SpacesReconciliation.referencesPass")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  const progress = yield* state();
  if (!progress.blocks_done) {
    const rows = yield* sql<{
      readonly block_id: string;
      readonly payload: string;
      readonly deleted: number;
    }>`
      SELECT block_id,CASE WHEN length(CAST(payload AS BLOB)) <= ${limits.maxBlockBytes} THEN payload ELSE '' END AS payload,deleted FROM spaces_blocks WHERE block_id > ${progress.block_cursor}
      ORDER BY block_id LIMIT 25`;
    for (const row of rows) {
      if (!row.deleted) {
        const ref = references(row.payload);
        let reason = ref.unresolved ? "unknown_payload" : null;
        if (ref.assetId !== null) {
          const [existing] = yield* sql<{
            readonly asset_id: string;
          }>`SELECT asset_id FROM spaces_block_asset_refs WHERE block_id = ${row.block_id}`;
          if (existing && existing.asset_id !== ref.assetId) reason = "conflicting_pin";
          else if (!existing)
            yield* sql`INSERT INTO spaces_block_asset_refs(block_id,asset_id) VALUES (${row.block_id},${ref.assetId})`;
          const available =
            yield* sql`SELECT 1 FROM spaces_assets a JOIN spaces_asset_blobs b ON b.digest = a.digest
            WHERE a.asset_id = ${ref.assetId} AND a.state = 'ready' AND b.state = 'ready'`;
          if (!available.length) reason = "asset_unavailable";
        }
        yield* issue("block", row.block_id, reason);
      } else
        yield* issue(
          "block",
          row.block_id,
          Option.isNone(tombstone(row.payload)) ? "unknown_payload" : null,
        );
      yield* sql`UPDATE spaces_asset_reconciliation SET block_cursor = ${row.block_id} WHERE singleton = 1`;
    }
    if (rows.length < 25)
      yield* sql`UPDATE spaces_asset_reconciliation SET blocks_done = 1 WHERE singleton = 1`;
    return;
  }
  if (progress.history_done) return;
  const [row] = yield* sql<{
    readonly page_id: string;
    readonly to_revision: number;
    readonly mutation_id: string;
    readonly created_at_ms: number;
    readonly expires_at_ms: number;
    readonly payload: string;
    readonly logical_bytes: number;
    readonly asset_count: number;
  }>`SELECT page_id,to_revision,mutation_id,created_at_ms,expires_at_ms,logical_bytes,asset_count,
    CASE WHEN length(CAST(payload AS BLOB)) <= ${historyLimits.maxDeltaBytes} THEN payload ELSE '' END AS payload
    FROM spaces_revisions WHERE (page_id,to_revision) > (${progress.history_page},${progress.history_revision})
    ORDER BY page_id,to_revision LIMIT 1`;
  if (!row) {
    yield* sql`UPDATE spaces_asset_reconciliation SET history_done = 1 WHERE singleton = 1`;
    return;
  }
  const ref = historical(row.payload);
  const pins = yield* sql<{
    readonly asset_id: string;
  }>`SELECT asset_id FROM spaces_revision_asset_refs
    WHERE page_id = ${row.page_id} AND to_revision = ${row.to_revision} ORDER BY asset_id LIMIT 100`;
  const oldIds = pins.map((pin) => pin.asset_id);
  const ids = [...new Set([...oldIds, ...ref.assets])].sort();
  const measure = (assetIds: readonly string[]) =>
    Buffer.byteLength(
      canonical(
        {
          pageId: row.page_id,
          toRevision: row.to_revision,
          mutationId: row.mutation_id,
          createdAtMs: row.created_at_ms,
          expiresAtMs: row.expires_at_ms,
          payload: row.payload,
          assetIds,
        },
        Number.MAX_SAFE_INTEGER,
      ),
    );
  let reason = ref.unresolved ? "unknown_payload" : null;
  if (oldIds.length !== row.asset_count || measure(oldIds) !== row.logical_bytes)
    reason = "invalid_accounting";
  else if (
    ids.length + 1 + (ref.unresolved ? 1 : 0) > historyLimits.cleanupBatchRows ||
    measure(ids) > historyLimits.maxDeltaBytes
  )
    reason = "capacity";
  else if (ids.length !== oldIds.length) {
    const delta = measure(ids) - row.logical_bytes;
    const [page] = yield* sql<{
      readonly retained_revision_bytes: number;
    }>`SELECT retained_revision_bytes FROM spaces_pages WHERE page_id = ${row.page_id}`;
    const [core] = yield* sql<{
      readonly revision_bytes: number;
    }>`SELECT revision_bytes FROM spaces_core WHERE singleton = 1`;
    if (
      !page ||
      !core ||
      page.retained_revision_bytes + delta > historyLimits.maxPageBytes ||
      core.revision_bytes + delta > historyLimits.maxEnvironmentBytes
    )
      reason = "capacity";
    else {
      for (const id of ids)
        if (!oldIds.includes(id))
          yield* sql`INSERT INTO spaces_revision_asset_refs(page_id,to_revision,asset_id) VALUES (${row.page_id},${row.to_revision},${id})`;
      yield* sql`UPDATE spaces_revisions SET logical_bytes = logical_bytes + ${delta},asset_count = ${ids.length} WHERE page_id = ${row.page_id} AND to_revision = ${row.to_revision}`;
      yield* sql`UPDATE spaces_pages SET retained_revision_bytes = retained_revision_bytes + ${delta} WHERE page_id = ${row.page_id}`;
      yield* sql`UPDATE spaces_core SET revision_bytes = revision_bytes + ${delta} WHERE singleton = 1`;
    }
  }
  yield* issue("history", key(row.page_id, row.to_revision), reason);
  yield* sql`UPDATE spaces_asset_reconciliation SET history_page = ${row.page_id},history_revision = ${row.to_revision} WHERE singleton = 1`;
});
