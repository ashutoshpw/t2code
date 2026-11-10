import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import { byteLength, ensureLimit } from "../CorePolicy.ts";
import * as Receipts from "../Receipts.ts";
import {
  decodeRecoveryResult,
  decodePurgeResult,
  decodeMoveBlocksResult,
  decodeRequest,
  decodeLookup,
  decodeCreateResult,
  decodeRenameResult,
  decodeDefaultResult,
  decodePageCreateResult,
  decodePageUpdateResult,
  decodeApplyResult,
  decodeCreateChildResult,
  decodeMovePageResult,
  isServiceError,
  validateRaw,
  checkIds,
} from "./Helpers.ts";
import { execute } from "./Execute.ts";
import type { Runtime } from "./Runtime.ts";

export const make = (rt: Runtime) => {
  const { admit, checkEnvironment, run } = rt;
  const mutate = Effect.fn("SpacesService.mutate")(function* (
    operation: C.SpaceMutationRequest["operation"],
    raw: unknown,
  ) {
    const environmentId = yield* admit();
    const request = yield* validateRaw({ operation, input: raw }).pipe(
      Effect.flatMap(decodeRequest),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, request.input.environmentId);
    return yield* run(
      environmentId,
      (meta, replay) =>
        Effect.gen(function* () {
          const found = replay ?? (yield* Receipts.find(request));
          if (found) return found;
          yield* ensureLimit("maxMutationBytes", byteLength(request));
          yield* checkIds(request.input);
          if ("title" in request.input)
            yield* ensureLimit("maxTitleBytes", byteLength(request.input.title));
          if (request.operation === "applyBlockBatch")
            yield* ensureLimit("maxMutationNodes", request.input.mutations.length);
          const epoch = yield* Receipts.active(meta);
          if (!epoch || epoch.epoch !== request.input.receiptEpoch)
            return yield* new C.SpaceMutationAdmissionError({
              receiptEpoch: request.input.receiptEpoch,
            });
          const receipt = yield* execute(request, meta);
          yield* Receipts.store(request, receipt, meta, epoch.retain_until);
          return receipt;
        }),
      request,
    );
  });
  const createSpace = Effect.fn("SpacesService.createSpace")(function* (input: unknown) {
    return decodeCreateResult((yield* mutate("createSpace", input)).result);
  });
  const renameSpace = Effect.fn("SpacesService.renameSpace")(function* (input: unknown) {
    return decodeRenameResult((yield* mutate("renameSpace", input)).result);
  });
  const setDefaultSpace = Effect.fn("SpacesService.setDefaultSpace")(function* (input: unknown) {
    return decodeDefaultResult((yield* mutate("setDefaultSpace", input)).result);
  });
  const createPage = Effect.fn("SpacesService.createPage")(function* (input: unknown) {
    return decodePageCreateResult((yield* mutate("createPage", input)).result);
  });
  const updatePage = Effect.fn("SpacesService.updatePage")(function* (input: unknown) {
    return decodePageUpdateResult((yield* mutate("updatePage", input)).result);
  });
  const applyBlockBatch = Effect.fn("SpacesService.applyBlockBatch")(function* (input: unknown) {
    return decodeApplyResult((yield* mutate("applyBlockBatch", input)).result);
  });
  const createChildPage = Effect.fn("SpacesService.createChildPage")(function* (input: unknown) {
    return decodeCreateChildResult((yield* mutate("createChildPage", input)).result);
  });
  const movePage = Effect.fn("SpacesService.movePage")(function* (input: unknown) {
    return decodeMovePageResult((yield* mutate("movePage", input)).result);
  });
  const moveBlocks = Effect.fn("SpacesService.moveBlocks")(function* (input: unknown) {
    return decodeMoveBlocksResult((yield* mutate("moveBlocks", input)).result);
  });
  const trashPage = Effect.fn("SpacesService.trashPage")(function* (input: unknown) {
    return decodeRecoveryResult((yield* mutate("trashPage", input)).result);
  });
  const restorePage = Effect.fn("SpacesService.restorePage")(function* (input: unknown) {
    return decodeRecoveryResult((yield* mutate("restorePage", input)).result);
  });
  const permanentlyDeletePage = Effect.fn("SpacesService.permanentlyDeletePage")(function* (
    input: unknown,
  ) {
    return decodePurgeResult((yield* mutate("permanentlyDeletePage", input)).result);
  });
  const lookupMutationReceipt = Effect.fn("SpacesService.lookupMutationReceipt")(function* (
    raw: unknown,
  ): Effect.fn.Return<C.SpaceReceiptLookupResult, C.SpaceServiceError> {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeLookup),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.request.input.environmentId);
    return yield* run(
      environmentId,
      (meta, replay) =>
        Effect.gen(function* () {
          const receipt = replay ?? (yield* Receipts.find(input.request));
          if (receipt) return { status: "found" as const, receipt };
          yield* checkIds(input.request.input);
          const epoch = yield* Receipts.active(meta);
          return {
            status:
              epoch?.epoch === input.request.input.receiptEpoch
                ? ("absent" as const)
                : ("unknown" as const),
          };
        }),
      input.request,
    );
  });
  return {
    createSpace,
    renameSpace,
    setDefaultSpace,
    createPage,
    updatePage,
    applyBlockBatch,
    createChildPage,
    movePage,
    moveBlocks,
    trashPage,
    restorePage,
    permanentlyDeletePage,
    lookupMutationReceipt,
  };
};
