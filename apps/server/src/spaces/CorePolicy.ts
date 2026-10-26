import {
  SpaceLimitExceededError,
  SpaceValidationError,
  type SpaceLimits,
} from "@t2code/contracts/spaces";

export const limits: SpaceLimits = Object.freeze({
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
  maxReceiptRows: 10_000,
  maxReceiptStorageBytes: 67_108_864,
  maxEpochRows: 9,
  receiptRetentionMs: 604_800_000,
  cleanupBatchRows: 100,
});

export function checkLimit(limit: keyof SpaceLimits, actual: number, maximum = limits[limit]) {
  if (actual > maximum) throw new SpaceLimitExceededError({ limit, actual, maximum });
}

// Iterative canonicalization bounds raw input before recursive schema decoding, including opaque JSON.
export function canonical(value: unknown, ceiling = 1_048_576): string {
  const pending: Array<{ value: unknown; depth: number } | string> = [{ value, depth: 0 }];
  const parts: string[] = [];
  let bytes = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8");
      checkLimit("maxMutationBytes", bytes, ceiling);
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
      checkLimit("maxMutationBytes", Math.max(2, next.length * 2 + 1), ceiling);
      pending.push("]");
      for (let i = next.length - 1; i >= 0; i--) {
        pending.push({ value: next[i], depth: depth + 1 });
        if (i > 0) pending.push(",");
      }
      pending.push("[");
    } else if (typeof next === "object" && Object.getPrototypeOf(next) === Object.prototype) {
      const keys = Object.keys(next).sort();
      checkLimit("maxMutationBytes", Math.max(2, keys.length * 5 + 1), ceiling);
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
