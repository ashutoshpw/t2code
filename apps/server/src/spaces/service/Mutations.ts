import type { ThreadId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { byteLength, ensureLimit } from "../CorePolicy.ts";
import * as Receipts from "../Receipts.ts";
import {
  decodeRecoveryResult,
  decodePurgeResult,
  decodeMoveBlocksResult,
  decodeRequest,
  strict,
  decodeLookup,
  decodeCreateResult,
  decodeRenameResult,
  decodeDefaultResult,
  decodePageCreateResult,
  decodePageUpdateResult,
  decodeApplyResult,
  decodeUnsyncResult,
  decodeCommentResult,
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
  const unsyncBlocks = Effect.fn("SpacesService.unsyncBlocks")(function* (input: unknown) {
    return decodeUnsyncResult((yield* mutate("unsyncBlocks", input)).result);
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
  const createCommentThread = Effect.fn("SpacesService.createCommentThread")(function* (
    input: unknown,
  ) {
    return decodeCommentResult((yield* mutate("createCommentThread", input)).result);
  });
  const replyComment = Effect.fn("SpacesService.replyComment")(function* (input: unknown) {
    return decodeCommentResult((yield* mutate("replyComment", input)).result);
  });
  const editComment = Effect.fn("SpacesService.editComment")(function* (input: unknown) {
    return decodeCommentResult((yield* mutate("editComment", input)).result);
  });
  const deleteComment = Effect.fn("SpacesService.deleteComment")(function* (input: unknown) {
    return decodeCommentResult((yield* mutate("deleteComment", input)).result);
  });
  const resolveCommentThread = Effect.fn("SpacesService.resolveCommentThread")(function* (
    input: unknown,
  ) {
    return decodeCommentResult((yield* mutate("resolveCommentThread", input)).result);
  });
  const reopenCommentThread = Effect.fn("SpacesService.reopenCommentThread")(function* (
    input: unknown,
  ) {
    return decodeCommentResult((yield* mutate("reopenCommentThread", input)).result);
  });
  const agentReplyComment = Effect.fn("SpacesService.agentReplyComment")(function* (
    input: C.SpaceCommentReplyInput,
    agentThreadId: ThreadId,
  ) {
    return decodeCommentResult(
      (yield* mutate("agentReplyComment", { ...input, agentThreadId })).result,
    );
  });
  const databaseMutation = <S extends Schema.Decoder<unknown>>(
    operation: C.SpaceMutationRequest["operation"],
    result: S,
  ) => {
    const decodeResult = Schema.decodeUnknownSync(result, strict);
    return Effect.fn(`SpacesService.${operation}`)(function* (input: unknown) {
      return decodeResult((yield* mutate(operation, input)).result);
    });
  };
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
    unsyncBlocks,
    createChildPage,
    movePage,
    moveBlocks,
    trashPage,
    restorePage,
    permanentlyDeletePage,
    createDatabase: databaseMutation("createDatabase", C.SpaceDatabaseCreateResult),
    updateDatabase: databaseMutation("updateDatabase", C.SpaceDatabaseUpdateResult),
    createDataSource: databaseMutation("createDataSource", C.SpaceDataSourceCreateResult),
    updateDataSource: databaseMutation("updateDataSource", C.SpaceDataSourceUpdateResult),
    deleteDataSource: databaseMutation("deleteDataSource", C.SpaceDataSourceDeleteResult),
    updateSchema: databaseMutation("updateSchema", C.SpaceSchemaUpdateResult),
    createView: databaseMutation("createView", C.SpaceViewCreateResult),
    updateView: databaseMutation("updateView", C.SpaceViewUpdateResult),
    deleteView: databaseMutation("deleteView", C.SpaceViewDeleteResult),
    createRows: databaseMutation("createRows", C.SpaceRowsCreateResult),
    updateRows: databaseMutation("updateRows", C.SpaceRowsUpdateResult),
    moveRows: databaseMutation("moveRows", C.SpaceRowsMoveResult),
    createCommentThread,
    replyComment,
    agentReplyComment,
    editComment,
    deleteComment,
    resolveCommentThread,
    reopenCommentThread,
    lookupMutationReceipt,
  };
};
