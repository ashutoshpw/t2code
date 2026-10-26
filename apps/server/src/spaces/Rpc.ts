import {
  RpcScopeAuthorization,
  WS_METHODS,
  WsSpacesListRpc,
  WsSpacesCreateRpc,
  WsSpacesRenameRpc,
  WsSpacesSetDefaultRpc,
  WsSpacesPagesListRpc,
  WsSpacesPagesGetRpc,
  WsSpacesPagesCreateRpc,
  WsSpacesPagesUpdateRpc,
  WsSpacesBlocksReadRpc,
  WsSpacesBlocksApplyRpc,
  WsSpacesReceiptsGetRpc,
  WsSpacesPagesCreateChildRpc,
  WsSpacesPagesMoveRpc,
  WsSpacesStructureInspectRpc,
  WsSpacesBlocksMoveRpc,
  WsSpacesReferencesResolveRpc,
  WsSpacesPagesTrashRpc,
  WsSpacesPagesRestoreRpc,
  WsSpacesPagesPermanentlyDeleteRpc,
  WsSpacesTrashListRpc,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";
import * as RpcGroup from "effect/rpc/RpcGroup";

import * as SpacesService from "./SpacesService.ts";
import { canonical } from "./CorePolicy.ts";

const invalidPayload = () =>
  new SchemaIssue.InvalidValue({ message: "Invalid Spaces RPC payload." });

// Unknown sees original intent before Struct can strip fields; errors never retain the offending payload.
const strictPayload = <S extends Schema.Top>(
  schema: S,
  envelope: (raw: unknown) => unknown = (raw) => raw,
) => {
  const decode = Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" });
  return Schema.Unknown.pipe(
    Schema.decodeTo(Schema.toType(schema), {
      decode: SchemaGetter.transformEffect((raw: unknown) =>
        Effect.try({
          try: () => {
            canonical(envelope(raw));
            return raw;
          },
          catch: invalidPayload,
        }).pipe(Effect.flatMap(decode), Effect.mapError(invalidPayload)),
      ),
      encode: SchemaGetter.transform((value) => value),
    }),
  );
};

export const group = RpcGroup.make(
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
  WsSpacesTrashListRpc.setPayload(strictPayload(C.SpaceTrashListInput)),
).middleware(RpcScopeAuthorization);

export const handlers = Effect.gen(function* () {
  const service = yield* SpacesService.SpacesService;
  return group.of({
    [WS_METHODS.spacesList]: (input) => service.listSpaces(input),
    [WS_METHODS.spacesCreate]: (input) => service.createSpace(input),
    [WS_METHODS.spacesRename]: (input) => service.renameSpace(input),
    [WS_METHODS.spacesSetDefault]: (input) => service.setDefaultSpace(input),
    [WS_METHODS.spacesPagesList]: (input) => service.listPages(input),
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
    [WS_METHODS.spacesTrashList]: (input) => service.listTrash(input),
  });
});
