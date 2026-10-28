import {
  RpcScopeAuthorization,
  WS_METHODS,
  WsSpacesListRpc,
  WsSpacesCreateRpc,
  WsSpacesRenameRpc,
  WsSpacesSetDefaultRpc,
  WsSpacesPagesListRpc,
  WsSpacesPagesListAllRpc,
  WsSpacesPinsAddRpc,
  WsSpacesPinsRemoveRpc,
  WsSpacesPinsListRpc,
  WsSpacesRecentsRecordRpc,
  WsSpacesRecentsListRpc,
  WsSpacesPagesGetRpc,
  WsSpacesPagesCreateRpc,
  WsSpacesPagesUpdateRpc,
  WsSpacesBlocksReadRpc,
  WsSpacesBlocksApplyRpc,
  WsSpacesReceiptsGetRpc,
  WsSpacesAssetsUploadCreateRpc,
  WsSpacesAssetsUploadGetRpc,
  WsSpacesAssetsUploadFinalizeRpc,
  WsSpacesAssetsGetRpc,
  WsSpacesAssetsListRpc,
  WsSpacesPagesCreateChildRpc,
  WsSpacesPagesMoveRpc,
  WsSpacesStructureInspectRpc,
  WsSpacesBlocksMoveRpc,
  WsSpacesReferencesResolveRpc,
  WsSpacesPagesTrashRpc,
  WsSpacesPagesRestoreRpc,
  WsSpacesPagesPermanentlyDeleteRpc,
  WsSpacesTrashListRpc,
  WsSpacesSearchRpc,
  WsSpacesContextCaptureRpc,
  SpaceContextCaptureInput,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as RpcGroup from "effect/rpc/RpcGroup";

import * as SpacesService from "./SpacesService.ts";
import { strictSpacePayload as strictPayload } from "./InputCodec.ts";

export const group = RpcGroup.make(
  WsSpacesAssetsUploadCreateRpc.setPayload(strictPayload(C.SpaceAssetUploadCreateInput)),
  WsSpacesAssetsUploadGetRpc.setPayload(strictPayload(C.SpaceAssetUploadInput)),
  WsSpacesAssetsUploadFinalizeRpc.setPayload(strictPayload(C.SpaceAssetUploadInput)),
  WsSpacesAssetsGetRpc.setPayload(strictPayload(C.SpaceAssetGetInput)),
  WsSpacesAssetsListRpc.setPayload(strictPayload(C.SpaceAssetListInput)),
  WsSpacesContextCaptureRpc.setPayload(strictPayload(SpaceContextCaptureInput)),
  WsSpacesListRpc.setPayload(strictPayload(C.SpaceListInput)),
  WsSpacesCreateRpc.setPayload(
    strictPayload(C.SpaceCreateInput, (input) => ({ operation: "createSpace", input })),
  ),
  WsSpacesRenameRpc.setPayload(
    strictPayload(C.SpaceRenameInput, (input) => ({ operation: "renameSpace", input })),
  ),
  WsSpacesSetDefaultRpc.setPayload(
    strictPayload(C.SpaceSetDefaultInput, (input) => ({ operation: "setDefaultSpace", input })),
  ),
  WsSpacesPagesListRpc.setPayload(strictPayload(C.SpacePageListInput)),
  WsSpacesPagesListAllRpc.setPayload(strictPayload(C.SpaceListInput)),
  WsSpacesPinsAddRpc.setPayload(strictPayload(C.SpacePageGetInput)),
  WsSpacesPinsRemoveRpc.setPayload(strictPayload(C.SpacePageGetInput)),
  WsSpacesPinsListRpc.setPayload(strictPayload(C.SpaceListInput)),
  WsSpacesRecentsRecordRpc.setPayload(strictPayload(C.SpacePageGetInput)),
  WsSpacesRecentsListRpc.setPayload(strictPayload(C.SpaceListInput)),

  WsSpacesPagesGetRpc.setPayload(strictPayload(C.SpacePageGetInput)),
  WsSpacesPagesCreateRpc.setPayload(
    strictPayload(C.SpacePageCreateInput, (input) => ({ operation: "createPage", input })),
  ),
  WsSpacesPagesUpdateRpc.setPayload(
    strictPayload(C.SpacePageUpdateInput, (input) => ({ operation: "updatePage", input })),
  ),
  WsSpacesBlocksReadRpc.setPayload(strictPayload(C.SpaceReadBlocksInput)),
  WsSpacesBlocksApplyRpc.setPayload(
    strictPayload(C.SpaceApplyBlockBatchInput, (input) => ({
      operation: "applyBlockBatch",
      input,
    })),
  ),
  WsSpacesReceiptsGetRpc.setPayload(strictPayload(C.SpaceReceiptLookupInput)),
  WsSpacesPagesCreateChildRpc.setPayload(
    strictPayload(C.SpaceCreateChildPageInput, (input) => ({
      operation: "createChildPage",
      input,
    })),
  ),
  WsSpacesPagesMoveRpc.setPayload(
    strictPayload(C.SpaceMovePageInput, (input) => ({ operation: "movePage", input })),
  ),
  WsSpacesStructureInspectRpc.setPayload(strictPayload(C.SpaceInspectStructureInput)),
  WsSpacesBlocksMoveRpc.setPayload(
    strictPayload(C.SpaceMoveBlocksInput, (input) => ({ operation: "moveBlocks", input })),
  ),
  WsSpacesReferencesResolveRpc.setPayload(strictPayload(C.SpaceReferenceResolveInput)),
  WsSpacesPagesTrashRpc.setPayload(
    strictPayload(C.SpacePageRecoveryInput, (input) => ({ operation: "trashPage", input })),
  ),
  WsSpacesPagesRestoreRpc.setPayload(
    strictPayload(C.SpacePageRecoveryInput, (input) => ({ operation: "restorePage", input })),
  ),
  WsSpacesPagesPermanentlyDeleteRpc.setPayload(
    strictPayload(C.SpacePageRecoveryInput, (input) => ({
      operation: "permanentlyDeletePage",
      input,
    })),
  ),
  WsSpacesSearchRpc.setPayload(strictPayload(C.SpaceSearchInput)),
  WsSpacesTrashListRpc.setPayload(strictPayload(C.SpaceTrashListInput)),
).middleware(RpcScopeAuthorization);

export const handlers = Effect.fn("SpacesRpc.handlers")(function* (callerId: string) {
  const service = yield* SpacesService.SpacesService;
  return group.of({
    [WS_METHODS.spacesAssetsUploadCreate]: (input) => service.createAssetUpload(input, callerId),
    [WS_METHODS.spacesAssetsUploadGet]: (input) => service.getAssetUpload(input, callerId),
    [WS_METHODS.spacesAssetsUploadFinalize]: (input) =>
      service.finalizeAssetUpload(input, callerId),
    [WS_METHODS.spacesAssetsGet]: (input) => service.getAssetMetadata(input),
    [WS_METHODS.spacesAssetsList]: (input) => service.listAssets(input),
    [WS_METHODS.spacesContextCapture]: (input) => service.captureContextSnapshot(input),
    [WS_METHODS.spacesList]: (input) => service.listSpaces(input),
    [WS_METHODS.spacesCreate]: (input) => service.createSpace(input),
    [WS_METHODS.spacesRename]: (input) => service.renameSpace(input),
    [WS_METHODS.spacesSetDefault]: (input) => service.setDefaultSpace(input),
    [WS_METHODS.spacesPagesList]: (input) => service.listPages(input),
    [WS_METHODS.spacesPagesListAll]: (input) => service.listAllPages(input),
    [WS_METHODS.spacesPinsAdd]: (input) => service.addPin(input),
    [WS_METHODS.spacesPinsRemove]: (input) => service.removePin(input),
    [WS_METHODS.spacesPinsList]: (input) => service.listPins(input),
    [WS_METHODS.spacesRecentsRecord]: (input) => service.recordRecent(input),
    [WS_METHODS.spacesRecentsList]: (input) => service.listRecents(input),

    [WS_METHODS.spacesPagesGet]: (input) => service.getPage(input),
    [WS_METHODS.spacesPagesCreate]: (input) => service.createPage(input),
    [WS_METHODS.spacesPagesUpdate]: (input) => service.updatePage(input),
    [WS_METHODS.spacesBlocksRead]: (input) => service.readBlocks(input),
    [WS_METHODS.spacesBlocksApply]: (input) => service.applyBlockBatch(input),
    [WS_METHODS.spacesReceiptsGet]: (input) => service.lookupMutationReceipt(input),
    [WS_METHODS.spacesPagesCreateChild]: (input) => service.createChildPage(input),
    [WS_METHODS.spacesPagesMove]: (input) => service.movePage(input),
    [WS_METHODS.spacesStructureInspect]: (input) => service.inspectStructure(input),
    [WS_METHODS.spacesBlocksMove]: (input) => service.moveBlocks(input),
    [WS_METHODS.spacesReferencesResolve]: (input) => service.resolveReference(input),
    [WS_METHODS.spacesPagesTrash]: (input) => service.trashPage(input),
    [WS_METHODS.spacesPagesRestore]: (input) => service.restorePage(input),
    [WS_METHODS.spacesPagesPermanentlyDelete]: (input) => service.permanentlyDeletePage(input),
    [WS_METHODS.spacesSearch]: (input) => service.search(input),
    [WS_METHODS.spacesTrashList]: (input) => service.listTrash(input),
  });
});
