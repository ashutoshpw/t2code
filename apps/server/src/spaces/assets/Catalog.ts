// @effect-diagnostics nodeBuiltinImport:off -- server identities and bounded intent fingerprints use platform cryptography.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as SpacesSql from "../SpacesSql.ts";
import { canonical } from "../CorePolicy.ts";
import { fileLimits, assetLimits, mediaTypes, type MediaKind, type MediaType } from "./Policy.ts";
import {
  publicationInfo,
  missingPublicationInfo,
  type MissingPublication,
  absenceInfo,
  type Publication,
  type StagingAbsence,
} from "./Upload.ts";

const limits = Object.freeze({
  environmentBytes: assetLimits.maxEnvironmentBytes,
  callerPending: assetLimits.maxPendingPerCaller,
  environmentPending: assetLimits.maxPendingUploads,
  environmentActive: assetLimits.maxActiveUploads,
  reservationMs: assetLimits.uploadTtlMs,
  batchRows: assetLimits.recoveryBatchRows,
  recoveryBytes: assetLimits.recoveryBatchBytes,
});

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;

export class AssetCatalogError extends Schema.TaggedError<AssetCatalogError>()(
  "AssetCatalogError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "intent_mismatch",
      "not_found",
      "caller_mismatch",
      "expired",
      "already_claimed",
      "stale_attempt",
      "quota",
      "pending_limit",
      "active_limit",
      "blob_unavailable",
    ]),
  },
) {}
const error = (reason: AssetCatalogError["reason"]) => new AssetCatalogError({ reason });
const bounded = (value: string, maximum: number) =>
  typeof value === "string" &&
  Buffer.byteLength(value, "utf8") > 0 &&
  Buffer.byteLength(value, "utf8") <= maximum;
function validNow(now: number) {
  return (
    Number.isSafeInteger(now) && now >= 0 && now <= Number.MAX_SAFE_INTEGER - limits.reservationMs
  );
}

export interface UploadRow {
  readonly upload_id: string;
  readonly asset_id: string;
  readonly caller_id: string;
  readonly request_id: string;
  readonly fingerprint: string;
  readonly expected_bytes: number;
  readonly mime_type: MediaType;
  readonly media_kind: MediaKind;
  readonly name: string;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
  readonly state: "reserved" | "receiving" | "verified" | "ready" | "expired";
  readonly attempt_id: string | null;
  readonly digest: string | null;
  readonly blob_generation: number | null;
  readonly cleanup_pending: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly attempt_owner?: string | null;
  readonly staging_identity?: string | null;
  readonly staging_reserved?: number;
  readonly attempt_quiescent_at_ms?: number | null;
}
export interface Claim extends UploadRow {
  readonly attempt_id: string;
}
interface Usage {
  readonly reserved_bytes: number;
  readonly physical_bytes: number;
  readonly pending_count: number;
  readonly active_count: number;
}
interface Blob {
  readonly digest: string;
  readonly byte_size: number;
  readonly mime_type: MediaType;
  readonly media_kind: MediaKind;
  readonly state: "publishing" | "ready" | "deleting" | "deleted";
  readonly generation: number;
  readonly physical_charged: number;
  readonly deletion_attempt: string | null;
  readonly deletion_owner: string | null;
  readonly collected_generation: number | null;
}

export const usage = Effect.fn("SpacesAssetCatalog.usage")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<Usage>`SELECT reserved_bytes,physical_bytes,pending_count,active_count
    FROM spaces_asset_usage WHERE singleton = 1`;
  if (!row) return yield* error("not_found");
  return row;
});
export const getUpload = Effect.fn("SpacesAssetCatalog.getUpload")(function* (
  callerId: string,
  uploadId: string,
) {
  if (!bounded(callerId, 128) || !uuid.test(uploadId)) return yield* error("invalid_input");
  const sql = yield* SpacesSql.SpacesSql;
  const [row] =
    yield* sql<UploadRow>`SELECT * FROM spaces_asset_uploads WHERE upload_id = ${uploadId}`;
  if (!row) return yield* error("not_found");
  if (row.caller_id !== callerId) return yield* error("caller_mismatch");
  return row;
});
const claimed = Effect.fn("SpacesAssetCatalog.claimed")(function* (claim: Claim) {
  const row = yield* getUpload(claim.caller_id, claim.upload_id);
  if (row.attempt_id !== claim.attempt_id || row.asset_id !== claim.asset_id)
    return yield* error("stale_attempt");
  return row;
});
const releaseCounts = Effect.fn("SpacesAssetCatalog.releaseCounts")(function* (
  row: UploadRow,
  pending: boolean,
  reserved = pending,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const active = row.state === "receiving" || row.state === "verified" ? 1 : 0;
  yield* sql`UPDATE spaces_asset_usage SET active_count = active_count - ${active},
    pending_count = pending_count - ${pending ? 1 : 0},
    reserved_bytes = reserved_bytes - ${reserved ? row.expected_bytes : 0} WHERE singleton = 1`;
  yield* sql`UPDATE spaces_asset_callers SET active_count = active_count - ${active},
    pending_count = pending_count - ${pending ? 1 : 0} WHERE caller_id = ${row.caller_id}`;
  yield* sql`DELETE FROM spaces_asset_callers WHERE caller_id = ${row.caller_id} AND pending_count = 0 AND active_count = 0`;
});

// Every catalog mutation runs in the caller's existing Spaces transaction and writer boundary.
export const expireIdle = Effect.fn("SpacesAssetCatalog.expireIdle")(function* (now: number) {
  if (!validNow(now)) return yield* error("invalid_input");
  const sql = yield* SpacesSql.SpacesSql;
  const rows = yield* sql<UploadRow>`SELECT * FROM spaces_asset_uploads WHERE state = 'reserved'
    AND expires_at_ms <= ${now} ORDER BY expires_at_ms,upload_id LIMIT ${limits.batchRows}`;
  for (const row of rows) {
    yield* releaseCounts(row, true);
    yield* sql`UPDATE spaces_asset_uploads SET state = 'expired' WHERE upload_id = ${row.upload_id}`;
  }
  return rows.length;
});
export const reserve = Effect.fn("SpacesAssetCatalog.reserve")(function* (
  input: {
    readonly callerId: string;
    readonly requestId: string;
    readonly expectedBytes: number;
    readonly mimeType: MediaType;
    readonly mediaKind: MediaKind;
    readonly name: string;
  },
  now: number,
) {
  if (!validNow(now)) return yield* error("invalid_input");
  if (
    !bounded(input.callerId, 128) ||
    !bounded(input.requestId, 128) ||
    !bounded(input.name, 255) ||
    input.name === "." ||
    input.name === ".." ||
    !Object.hasOwn(mediaTypes, input.mimeType) ||
    mediaTypes[input.mimeType] !== input.mediaKind ||
    !Number.isSafeInteger(input.expectedBytes) ||
    input.expectedBytes < 1
  )
    return yield* error("invalid_input");
  const sql = yield* SpacesSql.SpacesSql;
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(canonical([input.expectedBytes, input.mimeType, input.mediaKind, input.name]))
    .digest("hex");
  const [existing] = yield* sql<UploadRow>`SELECT * FROM spaces_asset_uploads
    WHERE caller_id = ${input.callerId} AND request_id = ${input.requestId}`;
  if (existing) {
    if (existing.fingerprint !== fingerprint) return yield* error("intent_mismatch");
    return existing;
  }
  if (input.expectedBytes > fileLimits[input.mediaKind]) return yield* error("invalid_input");
  const current = yield* usage();
  const [caller] = yield* sql<{
    readonly pending_count: number;
  }>`SELECT pending_count FROM spaces_asset_callers WHERE caller_id = ${input.callerId}`;
  if (
    current.pending_count >= limits.environmentPending ||
    (caller?.pending_count ?? 0) >= limits.callerPending
  )
    return yield* error("pending_limit");
  if (
    current.physical_bytes + current.reserved_bytes + input.expectedBytes >
    limits.environmentBytes
  )
    return yield* error("quota");
  const uploadId = NodeCrypto.randomUUID();
  const assetId = NodeCrypto.randomUUID();
  yield* sql`INSERT INTO spaces_ids(id,kind) VALUES (${assetId},'asset')`;
  yield* sql`INSERT INTO spaces_asset_uploads(upload_id,asset_id,caller_id,request_id,fingerprint,expected_bytes,
    mime_type,media_kind,name,created_at_ms,expires_at_ms,state)
    VALUES (${uploadId},${assetId},${input.callerId},${input.requestId},${fingerprint},${input.expectedBytes},
      ${input.mimeType},${input.mediaKind},${input.name},${now},${now + limits.reservationMs},'reserved')`;
  yield* sql`UPDATE spaces_asset_usage SET reserved_bytes = reserved_bytes + ${input.expectedBytes},pending_count = pending_count + 1 WHERE singleton = 1`;
  yield* sql`INSERT INTO spaces_asset_callers(caller_id,pending_count,active_count) VALUES (${input.callerId},1,0)
    ON CONFLICT(caller_id) DO UPDATE SET pending_count = pending_count + 1`;
  return yield* getUpload(input.callerId, uploadId);
});
export const claim = Effect.fn("SpacesAssetCatalog.claim")(function* (
  callerId: string,
  uploadId: string,
  now: number,
  owner: string,
) {
  if (!validNow(now)) return yield* error("invalid_input");
  const sql = yield* SpacesSql.SpacesSql;
  if (
    !uuid.test(owner) ||
    !(yield* sql`SELECT 1 FROM spaces_asset_collection WHERE singleton=1 AND owner_token=${owner} AND owner_retired=0`)
      .length
  )
    return yield* error("blob_unavailable");
  const row = yield* getUpload(callerId, uploadId);
  if (row.state === "expired" || row.expires_at_ms <= now) return yield* error("expired");
  if (row.state !== "reserved") return yield* error("already_claimed");
  const current = yield* usage();
  if (current.active_count >= limits.environmentActive) return yield* error("active_limit");
  const attemptId = NodeCrypto.randomUUID();
  yield* sql`UPDATE spaces_asset_uploads SET state = 'receiving',attempt_id = ${attemptId},attempt_owner=${owner},staging_identity=NULL,attempt_quiescent_at_ms=NULL WHERE upload_id = ${uploadId}`;
  yield* sql`UPDATE spaces_asset_reconciliation SET staging_done = 0,staging_generation = staging_generation + 1 WHERE singleton = 1`;
  yield* sql`UPDATE spaces_asset_usage SET active_count = active_count + 1 WHERE singleton = 1`;
  yield* sql`UPDATE spaces_asset_callers SET active_count = active_count + 1 WHERE caller_id = ${callerId}`;
  return {
    ...row,
    state: "receiving" as const,
    attempt_id: attemptId,
    attempt_owner: owner,
    staging_identity: null,
  } satisfies Claim;
});
export const recordCreated = Effect.fn("SpacesAssetCatalog.recordCreated")(function* (
  claim: Claim,
  identity: { readonly dev: string; readonly ino: string; readonly birthtimeNs: string },
) {
  const sql = yield* SpacesSql.SpacesSql;
  const row = yield* claimed(claim);
  if (row.state !== "receiving" || !row.attempt_owner || row.attempt_owner !== claim.attempt_owner)
    return yield* error("stale_attempt");
  if (![identity.dev, identity.ino, identity.birthtimeNs].every((value) => /^[0-9]+$/.test(value)))
    return yield* error("invalid_input");
  yield* sql`UPDATE spaces_asset_uploads SET staging_identity=${`${identity.dev}:${identity.ino}:${identity.birthtimeNs}`} WHERE upload_id=${row.upload_id}`;
  yield* sql`UPDATE spaces_asset_reconciliation SET staging_done=0,staging_generation=staging_generation+1 WHERE singleton=1`;
});
export const recordVerified = Effect.fn("SpacesAssetCatalog.recordVerified")(function* (
  claim: Claim,
  staged: {
    readonly uploadId: string;
    readonly digest: string;
    readonly byteSize: number;
    readonly mimeType: MediaType;
    readonly mediaKind: MediaKind;
    readonly imageDimensions?: { readonly width: number; readonly height: number };
  },
  now: number,
) {
  if (!validNow(now)) return yield* error("invalid_input");
  const sql = yield* SpacesSql.SpacesSql;
  const row = yield* claimed(claim);
  if (
    staged.uploadId !== row.attempt_id ||
    !digestPattern.test(staged.digest) ||
    staged.byteSize !== row.expected_bytes ||
    staged.mimeType !== row.mime_type ||
    staged.mediaKind !== row.media_kind
  )
    return yield* error("intent_mismatch");
  const width = staged.imageDimensions?.width ?? null;
  const height = staged.imageDimensions?.height ?? null;
  if (row.state === "verified") {
    if (row.digest !== staged.digest || row.width !== width || row.height !== height)
      return yield* error("intent_mismatch");
    return row as Claim;
  }
  if (row.state !== "receiving") return yield* error("stale_attempt");
  if (row.expires_at_ms <= now) return yield* error("expired");
  if (
    row.media_kind === "image" &&
    (width === null ||
      height === null ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > fileLimits.imagePixels)
  )
    return yield* error("invalid_input");
  const [blob] = yield* sql<Blob>`SELECT * FROM spaces_asset_blobs WHERE digest = ${staged.digest}`;
  if (
    blob &&
    (blob.state === "deleting" ||
      (blob.state === "deleted" &&
        (blob.physical_charged !== 0 ||
          blob.deletion_attempt !== null ||
          blob.deletion_owner !== null ||
          blob.collected_generation !== blob.generation)) ||
      blob.byte_size !== staged.byteSize ||
      blob.mime_type !== staged.mimeType ||
      blob.media_kind !== staged.mediaKind)
  )
    return yield* error("blob_unavailable");
  if (blob?.state === "deleted")
    yield* sql`UPDATE spaces_asset_blobs SET state='publishing',generation=generation+1,unreferenced_at_ms=NULL,grace_epoch=-1,collected_generation=NULL
      WHERE digest=${staged.digest} AND state='deleted' AND physical_charged=0 AND deletion_attempt IS NULL`;
  if (!blob)
    yield* sql`INSERT INTO spaces_asset_blobs(digest,byte_size,mime_type,media_kind,state,created_at_ms)
    VALUES (${staged.digest},${staged.byteSize},${staged.mimeType},${staged.mediaKind},'publishing',${now})`;
  const generation = blob ? blob.generation + (blob.state === "deleted" ? 1 : 0) : 0;
  yield* sql`UPDATE spaces_asset_uploads SET state = 'verified',digest = ${staged.digest},
    blob_generation = ${generation},width = ${width},height = ${height} WHERE upload_id = ${row.upload_id}`;
  // A sweep opened after claim can predate actual private-file creation.
  yield* sql`UPDATE spaces_asset_reconciliation SET staging_done = 0,staging_generation = staging_generation + 1 WHERE singleton = 1`;
  return {
    ...row,
    state: "verified" as const,
    digest: staged.digest,
    blob_generation: generation,
    width,
    height,
  } as Claim;
});
export const finish = Effect.fn("SpacesAssetCatalog.finish")(function* (
  claim: Claim,
  proof: Publication,
  now: number,
) {
  if (!validNow(now)) return yield* error("invalid_input");
  const sql = yield* SpacesSql.SpacesSql;
  const row = yield* claimed(claim);
  const published = publicationInfo(proof);
  if (
    published.uploadId !== row.upload_id ||
    published.attemptId !== row.attempt_id ||
    published.digest !== row.digest ||
    published.byteSize !== row.expected_bytes ||
    published.generation !== row.blob_generation
  )
    return yield* error("intent_mismatch");
  if (row.state === "ready")
    return {
      assetId: row.asset_id,
      digest: row.digest!,
      byteSize: row.expected_bytes,
      name: row.name,
      mimeType: row.mime_type,
    };
  if (row.state !== "verified") return yield* error("stale_attempt");
  const [blob] = yield* sql<Blob>`SELECT * FROM spaces_asset_blobs WHERE digest = ${row.digest}`;
  if (
    !blob ||
    blob.generation !== row.blob_generation ||
    (blob.state !== "publishing" && blob.state !== "ready")
  )
    return yield* error("blob_unavailable");
  yield* sql`INSERT INTO spaces_assets(asset_id,digest,name,state,created_at_ms,width,height,blob_generation)
    VALUES (${row.asset_id},${row.digest},${row.name},'ready',${now},${row.width},${row.height},${row.blob_generation})`;
  yield* sql`UPDATE spaces_asset_blobs SET state = 'ready',physical_charged = 1 WHERE digest = ${row.digest}`;
  yield* sql`UPDATE spaces_core SET catalog_revision = catalog_revision + 1 WHERE singleton = 1`;
  yield* sql`DELETE FROM spaces_asset_reconciliation_issues WHERE kind = 'blob' AND entity = ${row.digest}`;
  yield* sql`UPDATE spaces_asset_reconciliation SET assets_done = 0,assets_generation = assets_generation + 1 WHERE singleton = 1`;
  if (!blob.physical_charged)
    yield* sql`UPDATE spaces_asset_usage SET physical_bytes = physical_bytes + ${row.expected_bytes} WHERE singleton = 1`;
  yield* releaseCounts(row, false, !published.separateStaging);
  yield* sql`UPDATE spaces_asset_uploads SET state = 'ready',cleanup_pending = 1,staging_reserved=${published.separateStaging ? 1 : 0} WHERE upload_id = ${row.upload_id}`;
  return {
    assetId: row.asset_id,
    digest: row.digest!,
    byteSize: row.expected_bytes,
    name: row.name,
    mimeType: row.mime_type,
  };
});
export const abort = Effect.fn("SpacesAssetCatalog.abort")(function* (
  claim: Claim,
  proof: StagingAbsence,
  now: number,
) {
  if (!validNow(now)) return yield* error("invalid_input");
  const sql = yield* SpacesSql.SpacesSql;
  const row = yield* claimed(claim);
  const absent = absenceInfo(proof);
  if (absent.uploadId !== row.upload_id || absent.attemptId !== row.attempt_id)
    return yield* error("intent_mismatch");
  if (row.state !== "receiving") return yield* error("stale_attempt");
  const expired = row.expires_at_ms <= now;
  yield* releaseCounts(row, expired);
  yield* sql`UPDATE spaces_asset_uploads SET state = ${expired ? "expired" : "reserved"},attempt_id = NULL,staging_identity=NULL,attempt_owner=NULL WHERE upload_id = ${row.upload_id}`;
});
export const readyAsset = Effect.fn("SpacesAssetCatalog.readyAsset")(function* (assetId: string) {
  if (!uuid.test(assetId)) return yield* error("invalid_input");
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<{
    readonly asset_id: string;
    readonly digest: string;
    readonly name: string;
    readonly byte_size: number;
    readonly mime_type: MediaType;
    readonly width: number | null;
    readonly height: number | null;
  }>`SELECT a.asset_id,a.digest,a.name,b.byte_size,b.mime_type,a.width,a.height
    FROM spaces_assets a JOIN spaces_asset_blobs b ON b.digest = a.digest
    WHERE a.asset_id = ${assetId} AND a.state = 'ready' AND b.state = 'ready'
    AND COALESCE(a.blob_generation,(SELECT u.blob_generation FROM spaces_asset_uploads u WHERE u.asset_id=a.asset_id AND u.digest=a.digest AND u.state='ready'))=b.generation
    AND NOT EXISTS (SELECT 1 FROM spaces_asset_reconciliation_issues i WHERE i.kind = 'blob' AND i.entity = b.digest)`;
  if (!row) return yield* error("not_found");
  return row;
});
export const revoke = Effect.fn("SpacesAssetCatalog.revoke")(function* (
  assetId: string,
  now: number,
) {
  if (!validNow(now)) return yield* error("invalid_input");
  const sql = yield* SpacesSql.SpacesSql;
  yield* readyAsset(assetId);
  yield* sql`UPDATE spaces_assets SET state = 'deleted',deleted_at_ms = ${now} WHERE asset_id = ${assetId}`;
});
export const recoveryBatch = Effect.fn("SpacesAssetCatalog.recoveryBatch")(function* (after = "") {
  if (after !== "" && !uuid.test(after)) return yield* error("invalid_input");
  const sql = yield* SpacesSql.SpacesSql;
  const rows = yield* sql<UploadRow>`SELECT * FROM spaces_asset_uploads
    WHERE (state IN ('receiving','verified') OR (state = 'ready' AND cleanup_pending = 1))
    AND upload_id > ${after} ORDER BY upload_id LIMIT ${limits.batchRows}`;
  const selected: UploadRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const cost = row.expected_bytes * 2;
    if (bytes + cost > limits.recoveryBytes) break;
    bytes += cost;
    selected.push(row);
  }
  return selected;
});

export const hasRecoveryPending = Effect.fn("SpacesAssetCatalog.hasRecoveryPending")(function* (
  activeUploads: ReadonlySet<string>,
) {
  const sql = yield* SpacesSql.SpacesSql;
  // Recovery rows retain pending slots; force their partial index instead of scanning historical ready rows.
  const rows = yield* sql<{
    readonly upload_id: string;
  }>`SELECT upload_id FROM spaces_asset_uploads INDEXED BY spaces_asset_recovery
    WHERE state IN ('receiving','verified') OR (state = 'ready' AND cleanup_pending = 1)
    ORDER BY upload_id LIMIT ${limits.environmentPending + 1}`;
  return rows.some((row) => !activeUploads.has(row.upload_id));
});

export const resetMissing = Effect.fn("SpacesAssetCatalog.resetMissing")(function* (
  claim: Claim,
  proof: MissingPublication,
  now: number,
) {
  if (!validNow(now)) return yield* error("invalid_input");
  const sql = yield* SpacesSql.SpacesSql;
  const row = yield* claimed(claim);
  const missing = missingPublicationInfo(proof);
  if (
    missing.uploadId !== row.upload_id ||
    missing.attemptId !== row.attempt_id ||
    missing.digest !== row.digest ||
    missing.generation !== row.blob_generation
  )
    return yield* error("intent_mismatch");
  if (row.state !== "verified") return yield* error("stale_attempt");
  const [blob] = yield* sql<Blob>`SELECT * FROM spaces_asset_blobs WHERE digest = ${row.digest}`;
  if (
    !blob ||
    blob.generation !== row.blob_generation ||
    blob.state !== "publishing" ||
    blob.physical_charged !== 0
  )
    return yield* error("blob_unavailable");
  const expired = row.expires_at_ms <= now;
  yield* releaseCounts(row, expired);
  yield* sql`UPDATE spaces_asset_uploads SET state = ${expired ? "expired" : "reserved"},attempt_id = NULL,
    digest = NULL,blob_generation = NULL,width = NULL,height = NULL,attempt_owner=NULL,staging_identity=NULL WHERE upload_id = ${row.upload_id}`;
  yield* sql`DELETE FROM spaces_asset_blobs WHERE digest = ${row.digest} AND state = 'publishing' AND physical_charged = 0
    AND NOT EXISTS(SELECT 1 FROM spaces_asset_uploads WHERE digest = ${row.digest})
    AND NOT EXISTS(SELECT 1 FROM spaces_assets WHERE digest = ${row.digest})`;
});

export const releaseStaging = Effect.fn("SpacesAssetCatalog.releaseStaging")(function* (
  claim: Claim,
  proof: StagingAbsence,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const row = yield* claimed(claim);
  const absent = absenceInfo(proof);
  if (absent.uploadId !== row.upload_id || absent.attemptId !== row.attempt_id)
    return yield* error("intent_mismatch");
  if (row.state !== "ready") return yield* error("stale_attempt");
  yield* sql`UPDATE spaces_asset_reconciliation SET staging_done = 0,staging_generation = staging_generation + 1 WHERE singleton = 1`;
  if (!row.cleanup_pending) return;
  yield* releaseCounts(row, true, row.staging_reserved !== 0);
  yield* sql`UPDATE spaces_asset_uploads SET cleanup_pending = 0,staging_identity=NULL,staging_reserved=0 WHERE upload_id = ${row.upload_id}`;
  const name = `${row.attempt_id}.part`;
  const [observation] = yield* sql<{
    readonly bytes: number;
  }>`SELECT bytes FROM spaces_asset_file_observations WHERE kind='staging' AND name=${name}`;
  yield* sql`DELETE FROM spaces_asset_file_observations WHERE kind='staging' AND name=${name}`;
  yield* sql`UPDATE spaces_asset_reconciliation SET staging_bytes=staging_bytes-${observation?.bytes ?? 0} WHERE singleton=1`;
  yield* sql`DELETE FROM spaces_asset_reconciliation_issues WHERE kind='file' AND entity=${canonical(["staging", name])}`;
});
