import {
  SpaceMutationId,
  type SpaceApplyBlockBatchInput,
  type SpaceApplyBlockBatchResult,
  type SpacePageGetInput,
  type SpacePageGetResult,
  type SpaceReceiptLookupInput,
  type SpaceReceiptLookupResult,
  type SpacePageTarget,
  type SpaceLimits,
} from "@t2code/contracts/spaces";
import type { SpaceSaveRequest, SpaceSessionAdapter } from "./session.ts";
import { spaceJsonBytes } from "./draft.ts";

export interface SpaceServicePorts {
  readonly getPage: (input: SpacePageGetInput) => Promise<SpacePageGetResult>;
  readonly applyBlockBatch: (
    input: SpaceApplyBlockBatchInput,
  ) => Promise<SpaceApplyBlockBatchResult>;
  readonly lookupMutationReceipt: (
    input: SpaceReceiptLookupInput,
  ) => Promise<SpaceReceiptLookupResult>;
  readonly limits: () => SpaceLimits;
}

export function createSpaceServiceSessionAdapter(
  key: SpacePageTarget,
  ports: SpaceServicePorts,
): SpaceSessionAdapter {
  function input(request: SpaceSaveRequest): SpaceApplyBlockBatchInput {
    if (
      request.key.environmentId !== key.environmentId ||
      request.key.pageId !== key.pageId ||
      !request.receiptEpoch
    )
      throw new Error("Cannot reconstruct this pending Spaces request");
    const value = {
      environmentId: key.environmentId,
      pageId: key.pageId,
      mutationId: SpaceMutationId.make(request.mutationId),
      receiptEpoch: request.receiptEpoch,
      baseRevision: request.baseRevision,
      generation: request.generation,
      mutations: request.mutations,
    };
    spaceJsonBytes({ operation: "applyBlockBatch", input: value }, 1024 * 1024);
    return value;
  }
  function result(request: SpaceSaveRequest, value: SpaceApplyBlockBatchResult) {
    if (
      value.mutationId !== request.mutationId ||
      value.receiptEpoch !== request.receiptEpoch ||
      value.generation !== request.generation ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < request.baseRevision
    )
      throw new Error("Spaces acknowledgement does not match the pending request");
    return { status: value.status, revision: value.revision };
  }
  return {
    getMutationAdmission: async () => (await ports.getPage(key)).mutationAdmission,
    validateNewRequest(request) {
      const value = input(request);
      const limits = ports.limits();
      spaceJsonBytes({ operation: "applyBlockBatch", input: value }, limits.maxMutationBytes);
      if (value.mutations.length > limits.maxMutationNodes)
        throw new Error("Spaces mutation exceeds node limit");
    },
    save: async (request) => result(request, await ports.applyBlockBatch(input(request))),
    lookupReceipt: async (request) => {
      const wrapper = { request: { operation: "applyBlockBatch" as const, input: input(request) } };
      spaceJsonBytes(wrapper, 1024 * 1024);
      const receipt = await ports.lookupMutationReceipt(wrapper);
      if (receipt.status !== "found") return receipt;
      if (receipt.receipt.operation !== "applyBlockBatch")
        throw new Error("Unexpected Spaces receipt operation");
      return result(request, receipt.receipt.result);
    },
  };
}
