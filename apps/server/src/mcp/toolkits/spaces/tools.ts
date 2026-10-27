import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  SpaceContextCaptureInput,
  SpaceContextCaptureResult,
  EnvironmentId,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as SpacesService from "../../../spaces/SpacesService.ts";
import { strictSpacePayload } from "../../../spaces/InputCodec.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const SpacesMcpError = Schema.Union([
  C.SpaceServiceError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
]);
const failure = Schema.toEncoded(SpacesMcpError);
const dependencies = [
  Invocation.McpInvocationContext,
  SpacesService.SpacesService,
  ThreadManagement.ThreadManagementService,
];
const structuredResult = Schema.makeFilter(
  (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value),
  { expected: "an MCP structured result object", toJsonSchema: () => [{ type: "object" }, true] },
);
const tool = <const N extends string, P extends Schema.Top, A extends Schema.Top>(
  name: N,
  parameters: P,
  success: A,
  description: string,
  operation?: string,
  destructive = false,
) =>
  Tool.make(name, {
    parameters: strictSpacePayload(
      parameters,
      operation ? (input) => ({ operation, input }) : undefined,
      true,
    ),
    success: success.check(structuredResult),
    failure,
    failureMode: "return",
    description: `${description} Input envelope <=1048576 JSON UTF-8 bytes; server policy applies.`,
    dependencies,
  })
    .annotate(Tool.Readonly, operation === undefined)
    .annotate(Tool.Destructive, destructive);

export const SpacesToolkit = Toolkit.make(
  tool(
    "t2_spaces_list",
    C.SpaceListInput,
    C.SpaceListResult,
    "List spaces; at most 50 rows and 65536 JSON bytes per cursor window.",
    undefined,
    false,
  ),
  tool(
    "t2_spaces_create",
    C.SpaceCreateInput,
    C.SpaceCreateResult,
    "Create a space with the original mutationId and receiptEpoch.",
    "createSpace",
    false,
  ),
  tool(
    "t2_spaces_rename",
    C.SpaceRenameInput,
    C.SpaceRenameResult,
    "Rename a space using its current revision guard.",
    "renameSpace",
    true,
  ),
  tool(
    "t2_spaces_set_default",
    C.SpaceSetDefaultInput,
    C.SpaceSetDefaultResult,
    "Set the default space using both space revision guards.",
    "setDefaultSpace",
    true,
  ),
  tool(
    "t2_spaces_pages_list",
    C.SpacePageListInput,
    C.SpacePageListResult,
    "List current root or child pages; at most 50 rows and 65536 JSON bytes per cursor window.",
    undefined,
    false,
  ),
  tool(
    "t2_spaces_pages_get",
    C.SpacePageGetInput,
    C.SpacePageGetResult,
    "Read current page metadata and mutation admission; no block bodies.",
    undefined,
    false,
  ),
  tool(
    "t2_spaces_pages_create",
    C.SpacePageCreateInput,
    C.SpacePageCreateResult,
    "Create a root page with the current root-order revision.",
    "createPage",
    false,
  ),
  tool(
    "t2_spaces_pages_update",
    C.SpacePageUpdateInput,
    C.SpacePageUpdateResult,
    "Update a page title with its expected revision.",
    "updatePage",
    true,
  ),
  tool(
    "t2_spaces_blocks_read",
    C.SpaceReadBlocksInput,
    C.SpaceReadBlocksResult,
    "Read a revision-checked block window; at most 100 blocks and 262144 JSON bytes.",
    undefined,
    false,
  ),
  tool(
    "t2_spaces_blocks_apply",
    C.SpaceApplyBlockBatchInput,
    C.SpaceApplyBlockBatchResult,
    "Apply insert/replace/delete batches with page revision, generation and original admission. Paragraph content uses runs:[{text,marks:[]}]; preserve opaque fields when replacing. Conflicts are returned unchanged.",
    "applyBlockBatch",
    true,
  ),
  tool(
    "t2_spaces_pages_create_child",
    C.SpaceCreateChildPageInput,
    C.SpaceCreateChildPageResult,
    "Create a nested page and owner block using the parent revision and generation.",
    "createChildPage",
    false,
  ),
  tool(
    "t2_spaces_pages_move",
    C.SpaceMovePageInput,
    C.SpaceMovePageResult,
    "Move a page using guards from structure_inspect and the original mutation admission.",
    "movePage",
    true,
  ),
  tool(
    "t2_spaces_structure_inspect",
    C.SpaceInspectStructureInput,
    C.SpaceInspectStructureResult,
    "Inspect current source/destination structure and revision guards before a move or recovery operation.",
    undefined,
    false,
  ),
  tool(
    "t2_spaces_blocks_move",
    C.SpaceMoveBlocksInput,
    C.SpaceMoveBlocksResult,
    "Move blocks using guards from structure_inspect; stable block IDs are preserved.",
    "moveBlocks",
    true,
  ),
  tool(
    "t2_spaces_references_resolve",
    C.SpaceReferenceResolveInput,
    C.SpaceReferenceResolveResult,
    "Resolve current stable page/block identity, including moves, merges and unavailable outcomes; hints are not authority.",
    undefined,
    false,
  ),
  tool(
    "t2_spaces_context_capture",
    SpaceContextCaptureInput,
    SpaceContextCaptureResult,
    "Capture current page/block text in one bounded read: 8 pages, 256 inspected blocks, depth 16, 2 MiB inspected bytes; output 16000 UTF-16/32768 UTF-8 text, 100 block IDs, 65536 JSON bytes. Child pages are opt-in; no historical source retention or media bytes.",
    undefined,
    false,
  ),
  tool(
    "t2_spaces_pages_trash",
    C.SpacePageRecoveryInput,
    C.SpacePageRecoveryResult,
    "Trash a page subtree with guards from structure_inspect and original mutation admission.",
    "trashPage",
    true,
  ),
  tool(
    "t2_spaces_pages_restore",
    C.SpacePageRecoveryInput,
    C.SpacePageRecoveryResult,
    "Restore a trashed page subtree using current structure guards and original mutation admission.",
    "restorePage",
    false,
  ),
  tool(
    "t2_spaces_pages_permanently_delete",
    C.SpacePageRecoveryInput,
    C.SpacePagePurgeResult,
    "Permanently delete a trashed page subtree using current structure guards and original mutation admission.",
    "permanentlyDeletePage",
    true,
  ),
  tool(
    "t2_spaces_trash_list",
    C.SpaceTrashListInput,
    C.SpaceTrashListResult,
    "List trash metadata in bounded cursor windows; no source bodies.",
    undefined,
    false,
  ),
  tool(
    "t2_spaces_search",
    C.SpaceSearchInput,
    C.SpaceSearchResult,
    "Search indexed current page/block text: canonical JSON query at most 256 UTF-8 bytes/8 terms; at most 50 hits/65536 JSON bytes. Mixed hits, opaque cursor, explicit building/unsupported outcomes; no kind filter or empty-query listing.",
    undefined,
    false,
  ),
  tool(
    "t2_spaces_receipts_get",
    C.SpaceReceiptLookupInput,
    C.SpaceReceiptLookupResult,
    "Look up the retained outcome of the exact original mutation request; never mint IDs, epochs or refresh guards.",
    undefined,
    false,
  ),
  tool(
    "t2_spaces_capability",
    Schema.Struct({ environmentId: EnvironmentId }),
    Schema.Struct({ capability: Schema.NullOr(C.SpaceCapability) }),
    "Read installed Spaces capabilities; capability is null while disabled or unavailable.",
  ),
);
