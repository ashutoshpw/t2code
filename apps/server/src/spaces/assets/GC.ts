// @effect-diagnostics nodeBuiltinImport:off -- immutable-byte verification and process-existence checks fence external deletion.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as C from "@t2code/contracts/spaces";

import * as SpacesSql from "../SpacesSql.ts";
import type { UploadRow } from "./Catalog.ts";
import { canonical } from "../CorePolicy.ts";
import { openMediaFile } from "../../assets/MediaFile.ts";
import { fileLimits, mediaTypes, type MediaType } from "./Policy.ts";

const grace = 86_400_000;
const maxRows = 100;
const maxBytes = 256 * 1024 ** 2;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const processAlive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH");
  }
};
const unavailable = () => new C.SpacesUnavailableError({ stage: "storage" });
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: unavailable });
interface State {
  readonly owner_token: string | null;
  readonly owner_pid: number | null;
  readonly owner_retired: number;
  readonly epoch: number;
  readonly projection_phase: string;
  readonly projection_cursor: string;
  readonly projection_page: string;
  readonly projection_revision: number;
  readonly projection_asset: string;
  readonly scan_cursor: string;
  readonly scan_done: number;
}
const ticketLease = Symbol("SpacesCollectionTicketLease");
interface Ticket {
  readonly [ticketLease]: { retired: boolean };
  readonly digest: string;
  readonly byte_size: number;
  readonly mime_type: MediaType;
  readonly media_kind: string;
  readonly generation: number;
  readonly deletion_attempt: string;
  readonly deletion_owner: string;
}
const ticketFor = (row: Ticket): Ticket => ({ ...row, [ticketLease]: { retired: false } });
const absent = Symbol("SpacesCollectedAbsence");
interface Absence {
  readonly [absent]: Ticket;
}
const state = Effect.fn("SpacesCollection.state")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<State>`SELECT * FROM spaces_asset_collection WHERE singleton=1`;
  if (!row) return yield* unavailable();
  return row;
});
export const initializeOwner = Effect.fn("SpacesCollection.initializeOwner")(function* (
  owner: string,
) {
  if (!uuid.test(owner)) return yield* unavailable();
  const sql = yield* SpacesSql.SpacesSql;
  const current = yield* state();
  const previousAlive =
    current.owner_pid === null || current.owner_pid === process.pid
      ? true
      : yield* Effect.sync(() => processAlive(current.owner_pid!));
  if (current.owner_token === owner) return true;
  if (current.owner_token !== null && !current.owner_retired && previousAlive) return false;
  yield* sql`UPDATE spaces_asset_collection SET owner_token=${owner},owner_pid=${process.pid},owner_retired=0 WHERE singleton=1`;
  return true;
});
export const retireOwner = Effect.fn("SpacesCollection.retireOwner")(function* (owner: string) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_asset_collection SET owner_retired=1 WHERE singleton=1 AND owner_token=${owner}`;
});
export const owns = Effect.fn("SpacesCollection.owns")(function* (owner: string) {
  const current = yield* state();
  return current.owner_token === owner && !current.owner_retired;
});
export const uploadActivity = Effect.fn("SpacesCollection.uploadActivity")(function* (
  owner: string,
  uploadId: string,
  now: number | null,
) {
  const sql = yield* SpacesSql.SpacesSql;
  if (
    !(yield* owns(owner)) ||
    !uuid.test(uploadId) ||
    (now !== null && (!Number.isSafeInteger(now) || now < 0))
  )
    return yield* unavailable();
  yield* sql`UPDATE spaces_asset_uploads SET attempt_quiescent_at_ms=${now}
    WHERE upload_id=${uploadId} AND attempt_owner IS NOT NULL
      AND (state IN ('receiving','verified') OR (state='ready' AND cleanup_pending=1))`;
});
export const readiness = Effect.fn("SpacesCollection.readiness")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<{
    readonly ready: number;
    readonly unresolved: number;
    readonly projection_pending: number;
  }>`
    SELECT c.projection_phase<>'done' AS projection_pending,
      EXISTS(SELECT 1 FROM spaces_asset_reconciliation_issues LIMIT 1)
      OR (c.projection_phase='done' AND (
        EXISTS(SELECT 1 FROM spaces_assets WHERE blob_generation IS NULL LIMIT 1)
        OR EXISTS(SELECT 1 FROM spaces_block_asset_refs WHERE blob_digest IS NULL LIMIT 1)
        OR EXISTS(SELECT 1 FROM spaces_revision_asset_refs WHERE blob_digest IS NULL LIMIT 1))) AS unresolved,
      c.projection_phase='done' AND c.owner_retired=0 AND c.owner_pid=${process.pid}
      AND r.format_version=4 AND r.blocks_done=1 AND r.history_done=1 AND r.blobs_done=1
      AND r.assets_done=1 AND r.staging_done=1
      AND NOT EXISTS(SELECT 1 FROM spaces_asset_reconciliation_issues LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM spaces_assets WHERE blob_generation IS NULL LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM spaces_block_asset_refs WHERE blob_digest IS NULL LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM spaces_revision_asset_refs WHERE blob_digest IS NULL LIMIT 1) AS ready
    FROM spaces_asset_collection c JOIN spaces_asset_reconciliation r ON r.singleton=c.singleton WHERE c.singleton=1`;
  if (!row) return yield* unavailable();
  return row;
});
export const pending = Effect.fn("SpacesCollection.pending")(function* (now: number) {
  const sql = yield* SpacesSql.SpacesSql;
  const current = yield* state();
  return (
    current.projection_phase !== "done" ||
    !current.scan_done ||
    (yield* sql`SELECT 1 FROM spaces_asset_blobs WHERE state='deleting' LIMIT 1`).length > 0 ||
    (yield* sql`SELECT 1 FROM spaces_asset_blobs WHERE state='ready' AND grace_epoch=${current.epoch}
      AND unreferenced_at_ms<=${now - grace} LIMIT 1`).length > 0
  );
});
const protectedDigest = Effect.fn("SpacesCollection.protectedDigest")(function* (digest: string) {
  const sql = yield* SpacesSql.SpacesSql;
  return (
    (yield* sql`SELECT 1 FROM spaces_block_asset_refs WHERE blob_digest=${digest} LIMIT 1`).length >
      0 ||
    (yield* sql`SELECT 1 FROM spaces_revision_asset_refs WHERE blob_digest=${digest} LIMIT 1`)
      .length > 0 ||
    (yield* sql`SELECT 1 FROM spaces_asset_uploads INDEXED BY spaces_asset_pending_digest
      WHERE digest=${digest} AND (state IN ('receiving','verified') OR cleanup_pending=1) LIMIT 1`)
      .length > 0
  );
});
const project = Effect.fn("SpacesCollection.project")(function* (current: State) {
  const sql = yield* SpacesSql.SpacesSql;
  if (current.projection_phase === "handles") {
    const rows = yield* sql<{
      readonly asset_id: string;
      readonly digest: string;
    }>`SELECT asset_id,digest FROM spaces_assets
      WHERE blob_generation IS NULL AND asset_id>${current.projection_cursor} ORDER BY asset_id LIMIT 10`;
    for (const row of rows) {
      const [upload] = yield* sql<{
        readonly blob_generation: number | null;
      }>`SELECT blob_generation FROM spaces_asset_uploads
        WHERE asset_id=${row.asset_id} AND digest=${row.digest} AND state='ready'`;
      if (upload?.blob_generation !== null && upload?.blob_generation !== undefined)
        yield* sql`UPDATE spaces_assets SET blob_generation=${upload.blob_generation} WHERE asset_id=${row.asset_id} AND blob_generation IS NULL`;
      else
        yield* sql`INSERT INTO spaces_asset_reconciliation_issues(kind,entity,reason) VALUES ('asset-generation',${row.asset_id},'unproven_generation')
        ON CONFLICT(kind,entity) DO NOTHING`;
    }
    yield* sql`UPDATE spaces_asset_collection SET projection_cursor=${rows.at(-1)?.asset_id ?? ""},
      projection_phase=${rows.length < 10 ? "current" : "handles"} WHERE singleton=1`;
    if (rows.length < 10)
      yield* sql`UPDATE spaces_asset_collection SET projection_cursor='' WHERE singleton=1`;
    return 32 + rows.length * 6;
  }
  if (current.projection_phase === "current") {
    const rows = yield* sql<{
      readonly block_id: string;
      readonly asset_id: string;
    }>`SELECT block_id,asset_id FROM spaces_block_asset_refs
      WHERE blob_digest IS NULL AND block_id>${current.projection_cursor} ORDER BY block_id LIMIT 10`;
    for (const row of rows)
      yield* sql`UPDATE spaces_block_asset_refs SET blob_digest=(SELECT digest FROM spaces_assets
      WHERE asset_id=${row.asset_id} AND blob_generation IS NOT NULL) WHERE block_id=${row.block_id}`;
    yield* sql`UPDATE spaces_asset_collection SET projection_cursor=${rows.at(-1)?.block_id ?? ""},
      projection_phase=${rows.length < 10 ? "history" : "current"} WHERE singleton=1`;
    return 32 + rows.length * 3;
  }
  const rows = yield* sql<{
    readonly page_id: string;
    readonly to_revision: number;
    readonly asset_id: string;
  }>`SELECT page_id,to_revision,asset_id
    FROM spaces_revision_asset_refs WHERE blob_digest IS NULL AND (page_id,to_revision,asset_id)>
      (${current.projection_page},${current.projection_revision},${current.projection_asset}) ORDER BY page_id,to_revision,asset_id LIMIT 10`;
  for (const row of rows)
    yield* sql`UPDATE spaces_revision_asset_refs SET blob_digest=(SELECT digest FROM spaces_assets
    WHERE asset_id=${row.asset_id} AND blob_generation IS NOT NULL) WHERE page_id=${row.page_id} AND to_revision=${row.to_revision} AND asset_id=${row.asset_id}`;
  const last = rows.at(-1);
  yield* sql`UPDATE spaces_asset_collection SET projection_page=${last?.page_id ?? ""},projection_revision=${last?.to_revision ?? -1},
    projection_asset=${last?.asset_id ?? ""},projection_phase=${rows.length < 10 ? "done" : "history"} WHERE singleton=1`;
  return 32 + rows.length * 3;
});
export const plan = Effect.fn("SpacesCollection.plan")(function* (owner: string, now: number) {
  const sql = yield* SpacesSql.SpacesSql;
  const current = yield* state();
  if (current.owner_token !== owner || current.owner_retired)
    return { handled: false, ticket: null };
  const [recovering] =
    yield* sql<Ticket>`SELECT digest,byte_size,mime_type,media_kind,generation,deletion_attempt,deletion_owner
    FROM spaces_asset_blobs WHERE state='deleting' ORDER BY digest LIMIT 1`;
  if (recovering) {
    if (recovering.byte_size < 1 || recovering.byte_size * 2 > maxBytes)
      return yield* unavailable();
    yield* sql`UPDATE spaces_asset_blobs SET deletion_owner=${owner} WHERE digest=${recovering.digest} AND state='deleting' AND generation=${recovering.generation}`;
    yield* sql`UPDATE spaces_asset_collection SET last_work_rows=64,last_planned_bytes=${recovering.byte_size * 2} WHERE singleton=1`;
    return { handled: true, ticket: ticketFor({ ...recovering, deletion_owner: owner }) };
  }
  if (current.projection_phase !== "done") {
    const cost = yield* project(current);
    if (cost > maxRows) return yield* unavailable();
    yield* sql`UPDATE spaces_asset_collection SET last_work_rows=${cost},last_planned_bytes=0 WHERE singleton=1`;
    return { handled: true, ticket: null };
  }
  if (!(yield* readiness()).ready) return { handled: false, ticket: null };
  const [due] =
    yield* sql<Ticket>`SELECT digest,byte_size,mime_type,media_kind,generation,deletion_attempt,deletion_owner
    FROM spaces_asset_blobs WHERE state='ready' AND grace_epoch=${current.epoch} AND unreferenced_at_ms<=${now - grace}
    ORDER BY unreferenced_at_ms,digest LIMIT 1`;
  if (due) {
    if (due.byte_size * 2 > maxBytes || due.byte_size < 1) return yield* unavailable();
    if (yield* protectedDigest(due.digest)) {
      yield* sql`UPDATE spaces_asset_blobs SET unreferenced_at_ms=NULL WHERE digest=${due.digest}`;
      return { handled: true, ticket: null };
    }
    const attempt = NodeCrypto.randomUUID();
    const rows =
      yield* sql<Ticket>`UPDATE spaces_asset_blobs SET state='deleting',generation=generation+1,
      deletion_attempt=${attempt},deletion_owner=${owner},deletion_error=NULL
      WHERE digest=${due.digest} AND state='ready' AND generation=${due.generation}
      RETURNING digest,byte_size,mime_type,media_kind,generation,deletion_attempt,deletion_owner`;
    yield* sql`UPDATE spaces_asset_collection SET last_work_rows=64,last_planned_bytes=${due.byte_size * 2} WHERE singleton=1`;
    return { handled: true, ticket: rows[0] ? ticketFor(rows[0]) : null };
  }
  if (current.scan_done) return { handled: false, ticket: null };
  const rows = yield* sql<{ readonly digest: string }>`SELECT digest FROM spaces_asset_blobs
    WHERE state='ready' AND digest>${current.scan_cursor} ORDER BY digest LIMIT 10`;
  for (const row of rows) {
    const pinned = yield* protectedDigest(row.digest);
    yield* sql`UPDATE spaces_asset_blobs SET unreferenced_at_ms=CASE WHEN ${pinned ? 1 : 0}=1 THEN NULL
      WHEN unreferenced_at_ms IS NULL OR grace_epoch<>${current.epoch} THEN ${now} ELSE unreferenced_at_ms END,
      grace_epoch=${current.epoch} WHERE digest=${row.digest} AND state='ready'`;
  }
  yield* sql`UPDATE spaces_asset_collection SET scan_cursor=${rows.at(-1)?.digest ?? ""},scan_done=${rows.length < 10 ? 1 : 0},
    last_work_rows=${32 + rows.length * 6},last_planned_bytes=0 WHERE singleton=1`;
  return { handled: true, ticket: null };
});
export const staging = Effect.fn("SpacesCollection.staging")(function* (
  owner: string,
  now: number,
  active: ReadonlySet<string>,
) {
  const sql = yield* SpacesSql.SpacesSql;
  if (!(yield* owns(owner))) return { handled: false, row: undefined };
  const rows =
    yield* sql<UploadRow>`SELECT * FROM spaces_asset_uploads INDEXED BY spaces_asset_recovery
    WHERE (state IN ('receiving','verified') OR (state='ready' AND cleanup_pending=1))
      AND attempt_owner IS NOT NULL AND (staging_identity IS NOT NULL OR state='receiving')
      AND created_at_ms<=${now - grace} AND expires_at_ms<=${now - grace} AND expected_bytes<=${Math.floor(maxBytes / 3)}
      AND (attempt_quiescent_at_ms IS NULL OR attempt_quiescent_at_ms<=${now - grace})
    ORDER BY upload_id LIMIT 17`;
  const row = rows.find((candidate) => !active.has(candidate.upload_id));
  if (row && row.attempt_quiescent_at_ms == null) {
    yield* uploadActivity(owner, row.upload_id, now);
    yield* sql`UPDATE spaces_asset_collection SET last_work_rows=90,last_planned_bytes=0 WHERE singleton=1`;
    return { handled: true, row: undefined };
  }
  if (row)
    yield* sql`UPDATE spaces_asset_collection SET last_work_rows=90,last_planned_bytes=${row.expected_bytes * 3} WHERE singleton=1`;
  return { handled: Boolean(row), row };
});
export const assertTicket = Effect.fn("SpacesCollection.assertTicket")(function* (ticket: Ticket) {
  const sql = yield* SpacesSql.SpacesSql;
  if (!(yield* owns(ticket.deletion_owner))) return yield* unavailable();
  const rows =
    yield* sql`SELECT 1 FROM spaces_asset_blobs WHERE digest=${ticket.digest} AND state='deleting'
    AND generation=${ticket.generation} AND deletion_attempt=${ticket.deletion_attempt} AND deletion_owner=${ticket.deletion_owner}`;
  if (!rows.length || (yield* protectedDigest(ticket.digest))) return yield* unavailable();
});
export const erase = Effect.fn("SpacesCollection.erase")(function* (
  ticket: Ticket,
  directory: string,
) {
  if (!ticket[ticketLease] || ticket[ticketLease].retired) return yield* unavailable();
  ticket[ticketLease].retired = true;
  yield* assertTicket(ticket);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    !/^[0-9a-f]{64}$/.test(ticket.digest) ||
    !uuid.test(ticket.deletion_attempt) ||
    !Number.isSafeInteger(ticket.generation) ||
    ticket.generation < 1 ||
    !path.isAbsolute(directory) ||
    !Object.hasOwn(mediaTypes, ticket.mime_type) ||
    mediaTypes[ticket.mime_type] !== ticket.media_kind ||
    !Number.isSafeInteger(ticket.byte_size) ||
    ticket.byte_size < 1 ||
    ticket.byte_size > fileLimits[mediaTypes[ticket.mime_type]] ||
    ticket.byte_size * 2 > maxBytes
  )
    return yield* unavailable();
  const filename = path.join(directory, ticket.digest);
  const missing = () =>
    Effect.tryPromise({
      try: async () => {
        try {
          await NodeFSP.lstat(filename);
          return false;
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return true;
          throw cause;
        }
      },
      catch: unavailable,
    });
  if (!(yield* missing()))
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* openMediaFile(filename).pipe(Effect.mapError(unavailable));
        if (!file || file.info.size !== BigInt(ticket.byte_size)) return yield* unavailable();
        const hash = NodeCrypto.createHash("sha256");
        const buffer = new Uint8Array(Math.min(65536, ticket.byte_size));
        let count = 0;
        while (count < ticket.byte_size) {
          const chunk = yield* io(() =>
            file.handle.read(buffer, 0, Math.min(buffer.length, ticket.byte_size - count), count),
          );
          if (!chunk.bytesRead) return yield* unavailable();
          hash.update(buffer.subarray(0, chunk.bytesRead));
          count += chunk.bytesRead;
        }
        const current = yield* io(() => NodeFSP.lstat(filename, { bigint: true }));
        if (
          hash.digest("hex") !== ticket.digest ||
          !current.isFile() ||
          current.dev !== file.info.dev ||
          current.ino !== file.info.ino ||
          current.birthtimeNs !== file.info.birthtimeNs ||
          current.mtimeNs !== file.info.mtimeNs ||
          current.size !== file.info.size
        )
          return yield* unavailable();
        yield* fs.remove(filename).pipe(Effect.mapError(unavailable));
      }),
    );
  if (!(yield* missing())) return yield* unavailable();
  return Object.freeze({ [absent]: Object.freeze({ ...ticket }) }) satisfies Absence;
});
export const complete = Effect.fn("SpacesCollection.complete")(function* (
  ticket: Ticket,
  proof: Absence,
  now: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const info = proof[absent];
  if (!info || canonical(info) !== canonical(ticket)) return yield* unavailable();
  if (!(yield* owns(ticket.deletion_owner))) return yield* unavailable();
  const rows = yield* sql<{
    readonly physical_charged: number;
  }>`UPDATE spaces_asset_blobs SET state='deleted',physical_charged=0,collected_generation=generation,
    deletion_attempt=NULL,deletion_owner=NULL,deletion_error=NULL,unreferenced_at_ms=NULL
    WHERE digest=${ticket.digest} AND state='deleting' AND physical_charged=1 AND byte_size=${ticket.byte_size} AND generation=${ticket.generation}
    AND deletion_attempt=${ticket.deletion_attempt} AND deletion_owner=${ticket.deletion_owner} RETURNING physical_charged`;
  if (!rows.length) return;
  // The charged tombstone and its absence proof commit together; no speculative quota release.
  yield* sql`UPDATE spaces_asset_usage SET physical_bytes=physical_bytes-${ticket.byte_size} WHERE singleton=1`;
  const [observed] = yield* sql<{
    readonly bytes: number;
  }>`SELECT bytes FROM spaces_asset_file_observations WHERE kind='assets' AND name=${ticket.digest}`;
  yield* sql`DELETE FROM spaces_asset_file_observations WHERE kind='assets' AND name=${ticket.digest}`;
  yield* sql`UPDATE spaces_asset_reconciliation SET assets_bytes=assets_bytes-${observed?.bytes ?? 0},observed_at_ms=${now} WHERE singleton=1`;
  yield* sql`DELETE FROM spaces_asset_reconciliation_issues WHERE (kind='blob' AND entity=${ticket.digest}) OR (kind='file' AND entity=${canonical(["assets", ticket.digest])})`;
});
export const failed = Effect.fn("SpacesCollection.failed")(function* (ticket: Ticket) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_asset_blobs SET deletion_error='io_failed' WHERE digest=${ticket.digest}
    AND state='deleting' AND generation=${ticket.generation} AND deletion_attempt=${ticket.deletion_attempt} AND deletion_owner=${ticket.deletion_owner}`;
});
