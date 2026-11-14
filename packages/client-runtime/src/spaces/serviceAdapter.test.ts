import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceBlockId,
  SpaceId,
  SpacePageId,
  SpaceReceiptEpoch,
  type SpaceApplyBlockBatchInput,
  type SpaceLimits,
  type SpaceReceiptLookupInput,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { createSpaceServiceSessionAdapter } from "./serviceAdapter.ts";
import type { SpaceSaveRequest } from "./session.ts";

const key = {
  environmentId: EnvironmentId.make("environment-1"),
  pageId: SpacePageId.make("source-page"),
};
const request: SpaceSaveRequest = {
  key,
  mutationId: "mutation-1",
  receiptEpoch: SpaceReceiptEpoch.make("epoch"),
  baseRevision: 4,
  generation: 2,
  mutations: [],
};
const limits: SpaceLimits = {
  maxListRows: 100,
  maxListResponseBytes: 262_144,
  maxBlockWindowBlocks: 100,
  maxBlockWindowResponseBytes: 262_144,
  maxMutationNodes: 100,
  maxMutationBytes: 262_144,
  maxBlockBytes: 32_768,
  maxDepth: 16,
  maxPageBlocks: 10_000,
  maxPageBytes: 8_388_608,
  maxIdBytes: 128,
  maxTitleBytes: 1_024,
  maxOrderBytes: 64,
  maxCursorBytes: 1_024,
  maxReceiptBytes: 1_048_576,
  maxReceiptRows: 1_000,
  maxReceiptStorageBytes: 8_388_608,
  maxEpochRows: 10,
  receiptRetentionMs: 86_400_000,
  cleanupBatchRows: 100,
};

describe("service session adapter scope", () => {
  it("saves a copy's edits to the original's page with its base revision and reports a conflict", async () => {
    const saved: SpaceApplyBlockBatchInput[] = [];
    const looked: SpaceReceiptLookupInput[] = [];
    const adapter = createSpaceServiceSessionAdapter(
      key,
      {
        getPage: () => Promise.reject(new Error("unused")),
        limits: () => limits,
        applyBlockBatch: (input) => {
          saved.push(input);
          return Promise.resolve({
            status: "conflict",
            mutationId: input.mutationId,
            receiptEpoch: input.receiptEpoch,
            generation: input.generation,
            revision: 9,
            current: {
              catalogRevision: 0,
              defaultSpaceId: SpaceId.make("space-1"),
              spaces: [],
              pages: [],
            },
          });
        },
        lookupMutationReceipt: (input) => {
          looked.push(input);
          return Promise.resolve({ status: "absent" });
        },
      },
      { subtreeRootId: SpaceBlockId.make("original") },
    );
    expect(await adapter.save(request)).toEqual({ status: "conflict", revision: 9 });
    expect(await adapter.lookupReceipt(request)).toEqual({ status: "absent" });
    expect(saved[0]).toMatchObject({
      pageId: "source-page",
      baseRevision: 4,
      subtreeRootId: "original",
    });
    expect(looked[0]!.request.input).toMatchObject({ subtreeRootId: "original" });
  });

  it("leaves the key out of ordinary page saves", async () => {
    const saved: SpaceApplyBlockBatchInput[] = [];
    const adapter = createSpaceServiceSessionAdapter(key, {
      getPage: () => Promise.reject(new Error("unused")),
      limits: () => limits,
      applyBlockBatch: (input) => {
        saved.push(input);
        return Promise.resolve({
          status: "saved",
          mutationId: input.mutationId,
          receiptEpoch: input.receiptEpoch,
          generation: input.generation,
          revision: 5,
        });
      },
      lookupMutationReceipt: () => Promise.resolve({ status: "absent" }),
    });
    await adapter.save(request);
    expect("subtreeRootId" in saved[0]!).toBe(false);
  });
});
