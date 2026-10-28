// @effect-diagnostics nodeBuiltinImport:off -- canonical request binding uses the platform SHA-256 implementation.
import * as NodeCrypto from "node:crypto";

import type { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { canonical, checkLimit, limits } from "./CorePolicy.ts";
import * as SpacesSql from "./SpacesSql.ts";

export interface Metadata {
  readonly environment_id: string | null;
  readonly catalog_revision: number;
  readonly observed_time_ms: number;
  readonly active_epoch: string | null;
  readonly receipt_rows: number;
  readonly receipt_bytes: number;
}

const receiptDecoder = Schema.decodeUnknownEffect(Schema.fromJsonString(C.SpaceMutationReceipt), {
  onExcessProperty: "error",
});
const fingerprint = (request: C.SpaceMutationRequest) =>
  NodeCrypto.createHash("sha256").update(canonical(request)).digest("hex");

// The service transaction owns these helpers and their clock/cleanup decisions.
export const observe = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
  const sql = yield* SpacesSql.SpacesSql;
  const [meta] = yield* sql<Metadata>`SELECT * FROM spaces_core WHERE singleton = 1`;
  if (!meta) return yield* new C.SpacesUnavailableError({ stage: "storage" });
  if (meta.environment_id !== null && meta.environment_id !== environmentId)
    return yield* new C.SpaceEnvironmentMismatchError({ environmentId });
  const now = Math.max(meta.observed_time_ms, yield* Clock.currentTimeMillis);
  yield* sql`UPDATE spaces_core SET environment_id = ${environmentId}, observed_time_ms = ${now} WHERE singleton = 1`;
  return { ...meta, observed_time_ms: now };
});

export const active = Effect.fnUntraced(function* (meta: Metadata) {
  const sql = yield* SpacesSql.SpacesSql;
  const [epoch] = yield* sql<{
    readonly epoch: C.SpaceReceiptEpoch;
    readonly accepts_until: number;
    readonly retain_until: number;
  }>`
    SELECT * FROM spaces_epochs WHERE epoch = ${meta.active_epoch}`;
  return epoch && meta.observed_time_ms < epoch.accepts_until ? epoch : undefined;
});

export const cleanup = Effect.fnUntraced(function* (meta: Metadata) {
  const sql = yield* SpacesSql.SpacesSql;
  const expired = yield* sql<{ readonly mutation_id: string; readonly logical_bytes: number }>`
      SELECT mutation_id, logical_bytes FROM spaces_receipts WHERE retain_until <= ${meta.observed_time_ms}
      ORDER BY retain_until, mutation_id LIMIT ${limits.cleanupBatchRows}`;
  if (expired.length) {
    yield* sql`DELETE FROM spaces_receipts WHERE mutation_id IN ${sql.in(expired.map((row) => row.mutation_id))}`;
    yield* sql`UPDATE spaces_core SET receipt_rows = receipt_rows - ${expired.length},
        receipt_bytes = receipt_bytes - ${expired.reduce((sum, row) => sum + row.logical_bytes, 0)} WHERE singleton = 1`;
  }
  yield* sql`DELETE FROM spaces_epochs WHERE epoch IN (
      SELECT epoch FROM spaces_epochs WHERE retain_until <= ${meta.observed_time_ms}
      AND NOT EXISTS (SELECT 1 FROM spaces_receipts WHERE spaces_receipts.epoch = spaces_epochs.epoch)
      ORDER BY retain_until, epoch LIMIT ${limits.cleanupBatchRows}
    )`;
});

export const issue = Effect.fnUntraced(function* (
  meta: Metadata,
): Effect.fn.Return<
  C.SpaceMutationAdmission,
  C.SpaceServiceError | import("effect/sql/SqlError").SqlError,
  SpacesSql.SpacesSql
> {
  const sql = yield* SpacesSql.SpacesSql;
  let epoch = yield* active(meta);
  if (!epoch) {
    const [count] = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM spaces_epochs`;
    if ((count?.count ?? 0) >= limits.maxEpochRows)
      return yield* new C.SpacesUnavailableError({ stage: "capacity" });
    const deadline = (Math.floor(meta.observed_time_ms / 86_400_000) + 1) * 86_400_000;
    epoch = {
      epoch: C.SpaceReceiptEpoch.make(NodeCrypto.randomUUID()),
      accepts_until: deadline,
      retain_until: deadline + limits.receiptRetentionMs,
    };
    yield* sql`INSERT INTO spaces_epochs (epoch, accepts_until, retain_until)
      VALUES (${epoch.epoch}, ${epoch.accepts_until}, ${epoch.retain_until})`;
    yield* sql`UPDATE spaces_core SET active_epoch = ${epoch.epoch} WHERE singleton = 1`;
  }
  return {
    epoch: epoch.epoch,
    acceptsUntil: DateTime.formatIso(DateTime.makeUnsafe(epoch.accepts_until)),
    retainUntil: DateTime.formatIso(DateTime.makeUnsafe(epoch.retain_until)),
  };
});

export const find = Effect.fnUntraced(function* (request: C.SpaceMutationRequest) {
  const sql = yield* SpacesSql.SpacesSql;
  const [stored] = yield* sql<{ readonly fingerprint: string; readonly payload: string }>`
    SELECT fingerprint, payload FROM spaces_receipts WHERE mutation_id = ${request.input.mutationId}`;
  if (!stored) return undefined;
  if (stored.fingerprint !== fingerprint(request))
    return yield* new C.SpaceMutationIdMismatchError({ mutationId: request.input.mutationId });
  const receipt = yield* receiptDecoder(stored.payload).pipe(
    Effect.mapError(() => new C.SpacesUnavailableError({ stage: "storage" })),
  );
  if (
    receipt.operation !== request.operation ||
    receipt.result.mutationId !== request.input.mutationId ||
    receipt.result.receiptEpoch !== request.input.receiptEpoch ||
    (request.operation === "applyBlockBatch" &&
      (receipt.operation !== "applyBlockBatch" ||
        receipt.result.generation !== request.input.generation))
  ) {
    return yield* new C.SpacesUnavailableError({ stage: "storage" });
  }
  return receipt;
});

export const store = Effect.fnUntraced(function* (
  request: C.SpaceMutationRequest,
  receipt: C.SpaceMutationReceipt,
  meta: Metadata,
  retainUntil: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const payload = canonical(receipt);
  checkLimit("maxReceiptBytes", Buffer.byteLength(payload, "utf8"));
  const logical = canonical({
    environmentId: request.input.environmentId,
    mutationId: request.input.mutationId,
    receiptEpoch: request.input.receiptEpoch,
    fingerprint: fingerprint(request),
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(meta.observed_time_ms)),
    retainUntil: DateTime.formatIso(DateTime.makeUnsafe(retainUntil)),
    receipt,
  });
  const bytes = Buffer.byteLength(logical, "utf8");
  checkLimit("maxReceiptRows", meta.receipt_rows + 1);
  checkLimit("maxReceiptStorageBytes", meta.receipt_bytes + bytes);
  yield* sql`INSERT INTO spaces_receipts (mutation_id, epoch, fingerprint, payload, logical_bytes, retain_until)
    VALUES (${request.input.mutationId}, ${request.input.receiptEpoch}, ${fingerprint(request)}, ${payload}, ${bytes}, ${retainUntil})`;
  yield* sql`UPDATE spaces_core SET receipt_rows = receipt_rows + 1, receipt_bytes = receipt_bytes + ${bytes} WHERE singleton = 1`;
});
