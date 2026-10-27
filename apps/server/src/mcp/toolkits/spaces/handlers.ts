import { type EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SpacesService from "../../../spaces/SpacesService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SpacesToolkit } from "./tools.ts";

// Registration and SpacesService already own tracing for this transport adapter.
const invoke = Effect.fnUntraced(function* <A>(
  input: { readonly environmentId: EnvironmentId } | C.SpaceReceiptLookupInput,
  run: (service: SpacesService.SpacesService["Service"]) => Effect.Effect<A, C.SpaceServiceError>,
) {
  const scope = yield* Invocation.requireMcpCapability("spaces");
  const environmentId =
    "request" in input ? input.request.input.environmentId : input.environmentId;
  if (environmentId !== scope.environmentId)
    return yield* new C.SpaceEnvironmentMismatchError({ environmentId: scope.environmentId });
  const service = yield* SpacesService.SpacesService;
  return yield* run(service);
});
export const layer = McpToolAccess.toLayer(SpacesToolkit, {
  t2_spaces_list: McpToolAccess.reads((input) =>
    invoke(input, (service) => service.listSpaces(input)),
  ),
  t2_spaces_create: McpToolAccess.writesWithCapability((input) =>
    invoke(input, (service) => service.createSpace(input)),
  ),
  t2_spaces_rename: McpToolAccess.writesWithCapability((input) =>
    invoke(input, (service) => service.renameSpace(input)),
  ),
  t2_spaces_set_default: McpToolAccess.writesWithCapability((input) =>
    invoke(input, (service) => service.setDefaultSpace(input)),
  ),
  t2_spaces_pages_list: McpToolAccess.reads((input) =>
    invoke(input, (service) => service.listPages(input)),
  ),
  t2_spaces_pages_get: McpToolAccess.reads((input) =>
    invoke(input, (service) => service.getPage(input)),
  ),
  t2_spaces_pages_create: McpToolAccess.writesWithCapability((input) =>
    invoke(input, (service) => service.createPage(input)),
  ),
  t2_spaces_pages_update: McpToolAccess.writesWithCapability((input) =>
    invoke(input, (service) => service.updatePage(input)),
  ),
  t2_spaces_blocks_read: McpToolAccess.reads((input) =>
    invoke(input, (service) => service.readBlocks(input)),
  ),
  t2_spaces_blocks_apply: McpToolAccess.writesWithCapability((input) =>
    invoke(input, (service) => service.applyBlockBatch(input)),
  ),
  t2_spaces_pages_create_child: McpToolAccess.writesWithCapability((input) =>
    invoke(input, (service) => service.createChildPage(input)),
  ),
  t2_spaces_pages_move: McpToolAccess.writesWithCapability((input) =>
    invoke(input, (service) => service.movePage(input)),
  ),
  t2_spaces_structure_inspect: McpToolAccess.reads((input) =>
    invoke(input, (service) => service.inspectStructure(input)),
  ),
  t2_spaces_blocks_move: McpToolAccess.writesWithCapability((input) =>
    invoke(input, (service) => service.moveBlocks(input)),
  ),
  t2_spaces_references_resolve: McpToolAccess.reads((input) =>
    invoke(input, (service) => service.resolveReference(input)),
  ),
  t2_spaces_context_capture: McpToolAccess.reads((input) =>
    invoke(input, (service) => service.captureContextSnapshot(input)),
  ),
  t2_spaces_pages_trash: McpToolAccess.writesWithCapability((input) =>
    invoke(input, (service) => service.trashPage(input)),
  ),
  t2_spaces_pages_restore: McpToolAccess.writesWithCapability((input) =>
    invoke(input, (service) => service.restorePage(input)),
  ),
  t2_spaces_pages_permanently_delete: McpToolAccess.writesWithCapability((input) =>
    invoke(input, (service) => service.permanentlyDeletePage(input)),
  ),
  t2_spaces_trash_list: McpToolAccess.reads((input) =>
    invoke(input, (service) => service.listTrash(input)),
  ),
  t2_spaces_search: McpToolAccess.reads((input) =>
    invoke(input, (service) => service.search(input)),
  ),
  t2_spaces_receipts_get: McpToolAccess.reads((input) =>
    invoke(input, (service) => service.lookupMutationReceipt(input)),
  ),
  t2_spaces_capability: McpToolAccess.reads((input) =>
    invoke(input, (service) => service.getCapability(input.environmentId)),
  ),
});
