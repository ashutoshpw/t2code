import { type EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import { issueAssetUrl } from "../../../assets/AssetAccess.ts";
import * as Effect from "effect/Effect";
import * as SpacesService from "../../../spaces/SpacesService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SpacesToolkit } from "./tools.ts";

// Registration and SpacesService already own tracing for this transport adapter.
const invoke = Effect.fnUntraced(function* <A, R>(
  input: { readonly environmentId: EnvironmentId } | C.SpaceReceiptLookupInput,
  run: (
    service: SpacesService.SpacesService["Service"],
    scope: Invocation.McpInvocationScope,
  ) => Effect.Effect<A, C.SpaceServiceError, R>,
) {
  const scope = yield* Invocation.requireMcpCapability("spaces");
  const environmentId =
    "request" in input ? input.request.input.environmentId : input.environmentId;
  if (environmentId !== scope.environmentId)
    return yield* new C.SpaceEnvironmentMismatchError({ environmentId: scope.environmentId });
  const service = yield* SpacesService.SpacesService;
  return yield* run(service, scope);
});
const invokeAsset = Effect.fnUntraced(function* <A, R>(
  input: { readonly environmentId: EnvironmentId },
  run: (
    service: SpacesService.SpacesService["Service"],
    scope: Invocation.McpInvocationScope,
  ) => Effect.Effect<A, C.SpaceServiceError, R>,
) {
  return yield* invoke(input, (service, scope) =>
    Effect.gen(function* () {
      const capability = yield* service.getCapability(input.environmentId);
      if (capability?.version !== 2 || capability.features?.assets !== true)
        return yield* new C.SpacesUnavailableError({ stage: "initializing" });
      return yield* run(service, scope);
    }),
  );
});
const assetCaller = Effect.fnUntraced(function* (scope: Invocation.McpInvocationScope) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(scope.requestNamespace))
    .pipe(Effect.mapError(() => new C.SpaceAssetError({ reason: "io_failed" })));
  return `mcp:${Hex.encode(digest)}`;
});
const isServiceError = Schema.is(C.SpaceServiceError);
export const layer = McpToolAccess.toLayer(SpacesToolkit, {
  t2_spaces_assets_upload_create: McpToolAccess.writesWithCapability((input) =>
    invokeAsset(input, (service, scope) =>
      assetCaller(scope).pipe(Effect.flatMap((caller) => service.createAssetUpload(input, caller))),
    ),
  ),
  t2_spaces_assets_upload_get: McpToolAccess.reads((input) =>
    invokeAsset(input, (service, scope) =>
      assetCaller(scope).pipe(Effect.flatMap((caller) => service.getAssetUpload(input, caller))),
    ),
  ),
  t2_spaces_assets_upload_finalize: McpToolAccess.writesWithCapability((input) =>
    invokeAsset(input, (service, scope) =>
      assetCaller(scope).pipe(
        Effect.flatMap((caller) => service.finalizeAssetUpload(input, caller)),
      ),
    ),
  ),
  t2_spaces_assets_get: McpToolAccess.reads((input) =>
    invokeAsset(input, (service) => service.getAssetMetadata(input)),
  ),
  t2_spaces_assets_read_url: McpToolAccess.reads((input) =>
    invokeAsset(input, () =>
      issueAssetUrl({ resource: { _tag: "spaces-asset", ...input } }).pipe(
        Effect.map(({ relativeUrl, expiresAt }) => ({
          assetId: input.assetId,
          relativeUrl,
          expiresAt,
        })),
        Effect.mapError((error) =>
          isServiceError(error) ? error : new C.SpaceAssetError({ reason: "io_failed" }),
        ),
      ),
    ),
  ),
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
    invoke(input, (service) =>
      service.getCapability(input.environmentId).pipe(Effect.map((capability) => ({ capability }))),
    ),
  ),
});
