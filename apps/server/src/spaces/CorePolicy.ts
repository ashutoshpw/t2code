import { assetLimits } from "./assets/Policy.ts";
import * as Effect from "effect/Effect";
import {
  SpaceLimitExceededError,
  SpaceValidationError,
  type SpaceLimits,
  type SpaceHistoryLimits,
  type SpaceSearchLimits,
  type SpaceDatabaseLimits,
} from "@t2code/contracts/spaces";

export const historyLimits: SpaceHistoryLimits = Object.freeze({
  maxRevisionsPerPage: 20,
  retentionMs: 604_800_000,
  maxDeltaBytes: 4_194_304,
  maxPageBytes: 8_388_608,
  maxEnvironmentBytes: 67_108_864,
  cleanupBatchRows: 100,
  cleanupBatchBytes: 4_194_304,
});

export const searchLimits: SpaceSearchLimits = Object.freeze({
  maxQueryBytes: 256,
  maxTerms: 8,
  maxRows: 50,
  maxResponseBytes: 65_536,
  maxCandidates: 500,
  maxCandidateBytes: 1_048_576,
  maxSnippetBytes: 512,
  backfillRows: 100,
  backfillBytes: 262_144,
});
export function ensureSearchLimit(limit: keyof SpaceSearchLimits, actual: number) {
  const maximum = searchLimits[limit];
  return actual > maximum
    ? Effect.fail(new SpaceLimitExceededError({ limit: `search.${limit}`, actual, maximum }))
    : Effect.void;
}
export const databaseLimits: SpaceDatabaseLimits = Object.freeze({
  maxDataSourcesPerDatabase: 8,
  maxViewsPerDatabase: 50,
  maxPropertiesPerDataSource: 100,
  maxDeletedPropertiesPerDataSource: 50,
  maxOptionsPerProperty: 200,
  maxNameBytes: 256,
  maxRowsPerDataSource: 25_000,
  maxRowsPerMutation: 100,
  maxCellsPerMutation: 500,
  maxSchemaOperations: 50,
  maxCellTextBytes: 16_384,
  maxCellItems: 100,
  maxSortKeyBytes: 128,
  maxFormulaBytes: 8_192,
  maxSchemaBytes: 65_536,
  maxViewBytes: 16_384,
  maxQueryRows: 100,
  maxQueryResponseBytes: 262_144,
  maxFilterDepth: 3,
  maxFilterConditions: 50,
  maxSorts: 8,
  maxGroupBuckets: 200,
  maxGroupPreviewRows: 25,
  maxAggregates: 50,
  maxRelatedPages: 500,
  maxCursorBytes: 4_096,
  maxSubItemDepth: 16,
});
/**
 * Rows one computed batch may recompute, and the evaluation steps it may spend doing so (a step
 * is roughly a microsecond or two of formula work). Whoever holds the write lock stops at the
 * first limit reached; the rest stays queued.
 */
export const computedDrainRows = 200;
export const computedDrainSteps = 40_000;

export function ensureDatabaseLimit(limit: keyof SpaceDatabaseLimits, actual: number) {
  const maximum = databaseLimits[limit];
  return actual > maximum
    ? Effect.fail(new SpaceLimitExceededError({ limit: `databases.${limit}`, actual, maximum }))
    : Effect.void;
}
type ScalarLimit = Exclude<
  keyof SpaceLimits,
  "history" | "search" | "assets" | "databases" | "maxReferenceHops"
>;

export const limits: SpaceLimits = Object.freeze({
  assets: assetLimits,
  history: historyLimits,
  search: searchLimits,
  databases: databaseLimits,
  maxReferenceHops: 32,
  maxListRows: 50,
  maxListResponseBytes: 65_536,
  maxBlockWindowBlocks: 100,
  maxBlockWindowResponseBytes: 262_144,
  maxMutationNodes: 100,
  maxMutationBytes: 262_144,
  maxBlockBytes: 32_768,
  maxDepth: 16,
  maxPageBlocks: 10_000,
  maxPageBytes: 33_554_432,
  maxIdBytes: 128,
  maxTitleBytes: 512,
  maxOrderBytes: 128,
  maxCursorBytes: 1_024,
  maxReceiptBytes: 65_536,
  maxReceiptRows: 50_000,
  maxReceiptStorageBytes: 67_108_864,
  maxEpochRows: 9,
  receiptRetentionMs: 604_800_000,
  cleanupBatchRows: 100,
});

export function ensureLimit(limit: ScalarLimit, actual: number, maximum = limits[limit]) {
  return actual > maximum
    ? Effect.fail(new SpaceLimitExceededError({ limit, actual, maximum }))
    : Effect.void;
}

// Iterative canonicalization bounds raw input before recursive schema decoding, including opaque JSON.
export function canonical(
  value: unknown,
  ceiling = 1_048_576,
  limit: ScalarLimit | "history.maxDeltaBytes" = "maxMutationBytes",
): string {
  const check = (actual: number) => {
    if (actual > ceiling) throw new SpaceLimitExceededError({ limit, actual, maximum: ceiling });
  };
  const pending: Array<{ value: unknown; depth: number } | string> = [{ value, depth: 0 }];
  const parts: string[] = [];
  let bytes = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8");
      check(bytes);
      parts.push(item);
      continue;
    }
    const { value: next, depth } = item;
    if (depth > 128) throw new SpaceValidationError({ reason: "invalid_input" });
    if (
      next === null ||
      typeof next === "string" ||
      typeof next === "boolean" ||
      (typeof next === "number" && Number.isFinite(next))
    ) {
      pending.push(JSON.stringify(next));
    } else if (Array.isArray(next)) {
      check(Math.max(2, next.length * 2 + 1));
      pending.push("]");
      for (let i = next.length - 1; i >= 0; i--) {
        pending.push({ value: next[i], depth: depth + 1 });
        if (i > 0) pending.push(",");
      }
      pending.push("[");
    } else if (typeof next === "object" && Object.getPrototypeOf(next) === Object.prototype) {
      const keys = Object.keys(next).sort();
      check(Math.max(2, keys.length * 5 + 1));
      pending.push("}");
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i]!;
        pending.push({ value: Reflect.get(next, key), depth: depth + 1 });
        pending.push(":", JSON.stringify(key));
        if (i > 0) pending.push(",");
      }
      pending.push("{");
    } else throw new SpaceValidationError({ reason: "invalid_input" });
  }
  return parts.join("");
}

export function byteLength(value: unknown) {
  return Buffer.byteLength(canonical(value, Number.MAX_SAFE_INTEGER), "utf8");
}
