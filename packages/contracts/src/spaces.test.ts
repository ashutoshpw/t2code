import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  SpaceApplyBlockBatchInput,
  SpaceBlock,
  SpaceCapability,
  SpaceCreateInput,
  SpaceListInput,
  SpaceListResult,
  SpaceMutationReceipt,
  SpaceMutationRequest,
  SpacePageCreateInput,
  SpaceReadBlocksInput,
  SpaceReadBlocksResult,
  SpaceReceiptLookupInput,
  SpaceReceiptLookupResult,
  SpaceServiceError,
  SpaceSetDefaultInput,
  SpacePageSummary,
  SpacePageListInput,
} from "./spaces.ts";

const decode = Schema.decodeUnknownSync(SpaceBlock);
const encode = Schema.encodeSync(SpaceBlock);

describe("Spaces value preservation", () => {
  it.each([
    {
      id: "opaque",
      parentId: null,
      order: "a",
      type: "future-table",
      version: 7,
      content: { cells: [{ formula: "sum", refs: ["block-2"] }] },
      futureEnvelope: { enabled: true },
    },
    {
      id: "paragraph",
      parentId: "list",
      order: "b",
      type: "paragraph",
      version: 2,
      content: { futureRuns: [1, 2] },
    },
    {
      id: "marks",
      parentId: null,
      order: "c",
      type: "paragraph",
      version: 1,
      content: {
        runs: [
          {
            text: "keep",
            marks: [
              { type: "link", version: 1, href: "javascript:alert(1)" },
              { type: "future-mark", version: 4, opaque: { target: "block-2" } },
            ],
          },
        ],
      },
    },
  ])("round-trips opaque payloads without interpreting or stripping them ($id)", (raw) => {
    expect(encode(decode(raw))).toEqual(raw);
  });

  it("rejects a missing stable identity and non-JSON content", () => {
    expect(() =>
      decode({ parentId: null, order: "a", type: "paragraph", version: 1, content: {} }),
    ).toThrow();
    expect(() =>
      decode({
        id: "b",
        parentId: null,
        order: "a",
        type: "future",
        version: 1,
        content: { fn: () => 1 },
      }),
    ).toThrow();
  });
});

const strict = { onExcessProperty: "error" } as const;
const decodeRequest = Schema.decodeUnknownSync(SpaceMutationRequest, strict);
const decodeLookup = Schema.decodeUnknownSync(SpaceReceiptLookupInput, strict);
const decodeWindow = Schema.decodeUnknownSync(SpaceReadBlocksResult, strict);
const decodeCreate = Schema.decodeUnknownSync(SpaceCreateInput, strict);
const decodeBatch = Schema.decodeUnknownSync(SpaceApplyBlockBatchInput, strict);
const decodeReadBlocks = Schema.decodeUnknownSync(SpaceReadBlocksInput, strict);
const decodePageCreate = Schema.decodeUnknownSync(SpacePageCreateInput, strict);
const decodeSetDefault = Schema.decodeUnknownSync(SpaceSetDefaultInput, strict);
const decodeReceipt = Schema.decodeUnknownSync(SpaceMutationReceipt, strict);
const decodeLookupResult = Schema.decodeUnknownSync(SpaceReceiptLookupResult, strict);
const decodeList = Schema.decodeUnknownSync(SpaceListInput, strict);
const decodeListResult = Schema.decodeUnknownSync(SpaceListResult, strict);
const decodeError = Schema.decodeUnknownSync(SpaceServiceError, strict);
const decodeCapability = Schema.decodeUnknownSync(SpaceCapability, strict);
const encodeRequest = Schema.encodeSync(SpaceMutationRequest);
const encodeLookup = Schema.encodeSync(SpaceReceiptLookupInput);
const encodeWindow = Schema.encodeSync(SpaceReadBlocksResult);
const encodeError = Schema.encodeSync(SpaceServiceError);
const decodeSummary = Schema.decodeUnknownSync(SpacePageSummary, strict);
const encodeSummary = Schema.encodeSync(SpacePageSummary);
const decodePageList = Schema.decodeUnknownSync(SpacePageListInput, strict);
const acknowledgement = { mutationId: "mutation-1", receiptEpoch: "epoch-1" };
const writeContext = { environmentId: "environment-1", ...acknowledgement };
const space = {
  id: "space-1",
  title: "",
  isDefault: true,
  revision: 0,
  rootOrderRevision: 0,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};
const page = {
  id: "page-1",
  spaceId: space.id,
  title: "Page",
  revision: 4,
  rootOrder: "a",
  createdAt: space.createdAt,
  updatedAt: space.updatedAt,
};
const conflict = {
  status: "conflict",
  ...acknowledgement,
  current: { catalogRevision: 9, defaultSpaceId: space.id, spaces: [space], pages: [page] },
};
const batch = {
  ...writeContext,
  pageId: page.id,
  baseRevision: 4,
  generation: 2,
  mutations: [],
};

// Public decoding owns wire shape; service tests own execution, fingerprint and replay ordering.
describe("Spaces core protocol", () => {
  it("keeps legacy page receipts exact while decoding v2 locations, selectors, and distinct structure receipts", () => {
    expect(encodeSummary(decodeSummary(page))).toEqual(page);
    const nested = {
      ...page,
      rootOrder: null,
      location: { kind: "child", spaceId: space.id, parentPageId: "parent", ownerBlockId: "owner" },
    };
    expect(encodeSummary(decodeSummary(nested))).toEqual(nested);
    expect(
      decodePageList({
        environmentId: writeContext.environmentId,
        spaceId: space.id,
        parentPageId: "parent",
      }).parentPageId,
    ).toBe("parent");
    const placement = { pageId: "parent", parentId: null, beforeBlockId: null };
    const guards = {
      pages: [
        { pageId: "parent", revision: 2 },
        { pageId: page.id, revision: 4 },
      ],
      roots: [{ spaceId: space.id, rootOrderRevision: 1 }],
    };
    const create = {
      operation: "createChildPage",
      input: { ...writeContext, title: "Child", placement, guards },
    };
    const move = {
      operation: "movePage",
      input: {
        ...writeContext,
        pageId: page.id,
        destination: { kind: "child", placement },
        guards,
      },
    };
    expect(encodeRequest(decodeRequest(create))).toEqual(create);
    expect(encodeRequest(decodeRequest(move))).toEqual(move);
    const moveBlocks = {
      operation: "moveBlocks",
      input: {
        ...writeContext,
        sourcePageId: page.id,
        blockIds: ["block"],
        destination: placement,
        guards,
      },
    };
    expect(encodeRequest(decodeRequest(moveBlocks))).toEqual(moveBlocks);
    const movedBlocks = {
      operation: "moveBlocks",
      result: { status: "saved", ...acknowledgement, blockIds: ["block"], changed: guards },
    };
    expect(decodeReceipt(movedBlocks)).toEqual(movedBlocks);
    expect(() =>
      decodeRequest({ ...moveBlocks, input: { ...moveBlocks.input, blockIds: [] } }),
    ).toThrow();
    expect(() => decodeReceipt({ ...movedBlocks, operation: "applyBlockBatch" })).toThrow();
    expect(() =>
      decodeRequest({
        ...create,
        input: { ...create.input, placement: { ...placement, ownerBlockId: "forged" } },
      }),
    ).toThrow();
    expect(() =>
      decodeRequest({
        ...move,
        input: {
          ...move.input,
          destination: { kind: "root", spaceId: space.id, beforePageId: null, order: "clipboard" },
        },
      }),
    ).toThrow();
    const conflict = {
      status: "conflict",
      ...acknowledgement,
      current: { catalogRevision: 5, defaultSpaceId: space.id, ...guards },
    };
    expect(decodeReceipt({ operation: "movePage", result: conflict })).toEqual({
      operation: "movePage",
      result: conflict,
    });
    expect(() => decodeReceipt({ operation: "updatePage", result: conflict })).toThrow();
    const result = {
      status: "saved",
      ...acknowledgement,
      page: nested,
      ownerBlockId: "owner",
      changed: guards,
    };
    expect(decodeReceipt({ operation: "createChildPage", result })).toEqual({
      operation: "createChildPage",
      result,
    });
    expect(() => decodeReceipt({ operation: "createPage", result })).toThrow();
    const trashSummary = {
      ...nested,
      trash: { batchId: "batch", originalRootPageId: page.id, trashedAt: page.createdAt },
    };
    expect(encodeSummary(decodeSummary(trashSummary))).toEqual(trashSummary);
    for (const operation of ["trashPage", "restorePage", "permanentlyDeletePage"]) {
      const request = { operation, input: { ...writeContext, pageId: page.id, guards } };
      expect(encodeRequest(decodeRequest(request))).toEqual(request);
      const result =
        operation === "permanentlyDeletePage"
          ? {
              status: "saved",
              ...acknowledgement,
              pageId: page.id,
              deletedPageIds: [page.id],
              changed: guards,
            }
          : {
              status: "saved",
              ...acknowledgement,
              page: operation === "trashPage" ? trashSummary : page,
              changed: guards,
            };
      expect(decodeReceipt({ operation, result })).toEqual({ operation, result });
      expect(() =>
        decodeRequest({ ...request, input: { ...request.input, force: true } }),
      ).toThrow();
    }
  });

  it("decodes legacy capabilities and receipts while advertising optional independent history limits", () => {
    const old = {
      version: 1,
      limits: {
        maxListRows: 1,
        maxListResponseBytes: 1,
        maxBlockWindowBlocks: 1,
        maxBlockWindowResponseBytes: 1,
        maxMutationNodes: 1,
        maxMutationBytes: 1,
        maxBlockBytes: 1,
        maxDepth: 1,
        maxPageBlocks: 1,
        maxPageBytes: 1,
        maxIdBytes: 1,
        maxTitleBytes: 1,
        maxOrderBytes: 1,
        maxCursorBytes: 1,
        maxReceiptBytes: 1,
        maxReceiptRows: 1,
        maxReceiptStorageBytes: 1,
        maxEpochRows: 1,
        receiptRetentionMs: 1,
        cleanupBatchRows: 1,
      },
    };
    expect(decodeCapability(old)).toEqual(old);
    const history = {
      maxRevisionsPerPage: 20,
      retentionMs: 604_800_000,
      maxDeltaBytes: 8_388_608,
      maxPageBytes: 16_777_216,
      maxEnvironmentBytes: 67_108_864,
      cleanupBatchRows: 100,
      cleanupBatchBytes: 8_388_608,
    };
    const next = { ...old, limits: { ...old.limits, history, maxReferenceHops: 64 } };
    expect(decodeCapability(next)).toEqual(next);
    expect(() =>
      decodeCapability({
        ...old,
        limits: { ...old.limits, history: { ...history, maxDeltaBytes: 0 } },
      }),
    ).toThrow();
    const receipt = {
      operation: "updatePage",
      result: { status: "saved", ...acknowledgement, page },
    };
    expect(decodeReceipt(receipt)).toEqual(receipt);
    for (const limit of [
      "history.maxDeltaBytes",
      "history.maxPageBytes",
      "history.maxEnvironmentBytes",
    ]) {
      const raw = { _tag: "SpaceLimitExceededError", limit, actual: 2, maximum: 1 };
      expect(encodeError(decodeError(raw))).toEqual(raw);
    }
    for (const limit of ["history", "history.retentionMs"])
      expect(() =>
        decodeError({ _tag: "SpaceLimitExceededError", limit, actual: 2, maximum: 1 }),
      ).toThrow();
  });

  it("preserves opaque envelopes through strict request, lookup and block-window codecs", () => {
    const block = {
      id: "opaque",
      parentId: null,
      order: "a",
      type: "future-table",
      version: 7,
      content: { cells: [{ text: "keep", marks: [{ type: "future", metadata: [1, null] }] }] },
      futureEnvelope: { enabled: true },
    };
    const request = {
      operation: "applyBlockBatch",
      input: { ...batch, mutations: [{ kind: "replace", block }] },
    };
    const lookup = { request };
    expect(encodeRequest(decodeRequest(request))).toEqual(request);
    expect(encodeLookup(decodeLookup(lookup))).toEqual(lookup);
    const window = { revision: 4, blocks: [block], nextCursor: null };
    expect(encodeWindow(decodeWindow(window))).toEqual(window);
  });

  it("rejects unknown request fields at the strict decoding boundary", () => {
    const request = { operation: "applyBlockBatch", input: batch };
    expect(decodeRequest(request)).toEqual(request);
    for (const raw of [
      { ...request, placement: "root" },
      { ...request, input: { ...batch, parentPageId: "other-page" } },
      {
        ...request,
        input: { ...batch, mutations: [{ kind: "delete", blockId: "b", cascade: true }] },
      },
    ]) {
      expect(() => decodeRequest(raw)).toThrow();
    }
    expect(() => decodeCreate({ ...writeContext, title: "", parentPageId: "p" })).toThrow();
    expect(() => decodeLookup({ request, mutationId: "other" })).toThrow();
  });

  it("requires the original receipt epoch and preserves mutation intent exactly", () => {
    const raw = { ...writeContext, title: "  café\n  " };
    expect(decodeCreate(raw)).toEqual(raw);
    expect(decodeCreate({ ...raw, title: "" }).title).toBe("");
    const { receiptEpoch: _epoch, ...epochless } = raw;
    expect(() => decodeCreate(epochless)).toThrow();
    const { receiptEpoch: _batchEpoch, ...epochlessBatch } = batch;
    expect(() => decodeBatch(epochlessBatch)).toThrow();
    for (const field of ["receiptEpoch", "mutationId"]) {
      expect(() => decodeCreate({ ...raw, [field]: "" })).toThrow();
    }
    expect(decodeBatch(batch).generation).toBe(2);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects malformed revision and generation values (%s)",
    (revision) => {
      expect(() => decodeBatch({ ...batch, baseRevision: revision })).toThrow();
      expect(() => decodeBatch({ ...batch, generation: revision })).toThrow();
      expect(() =>
        decodeReadBlocks({
          environmentId: writeContext.environmentId,
          pageId: page.id,
          revision,
        }),
      ).toThrow();
      expect(() =>
        decodePageCreate({
          ...writeContext,
          spaceId: space.id,
          baseRootOrderRevision: revision,
          title: "",
        }),
      ).toThrow();
      expect(() =>
        decodeSetDefault({
          ...writeContext,
          spaceId: space.id,
          defaultSpaceId: space.id,
          baseRevision: 0,
          baseDefaultRevision: revision,
        }),
      ).toThrow();
    },
  );

  it("binds receipt operation tags to saved and conflict result shapes", () => {
    const saved = {
      operation: "createSpace",
      result: { status: "saved", ...acknowledgement, space },
    };
    expect(decodeReceipt(saved)).toEqual(saved);
    expect(() => decodeReceipt({ ...saved, operation: "updatePage" })).toThrow();
    expect(() => decodeReceipt({ ...saved, operation: "setDefaultSpace" })).toThrow();
    const pageCreated = {
      operation: "createPage",
      result: { status: "saved", ...acknowledgement, space, page },
    };
    expect(decodeReceipt(pageCreated)).toEqual(pageCreated);
    expect(() => decodeReceipt({ ...pageCreated, operation: "updatePage" })).toThrow();
    expect(() => decodeReceipt({ operation: "createSpace", result: conflict })).toThrow();
    expect(() => decodeReceipt({ operation: "deletePage", result: conflict })).toThrow();
    const blockConflict = {
      operation: "applyBlockBatch",
      result: { ...conflict, generation: 2, revision: 4 },
    };
    expect(decodeReceipt(blockConflict)).toEqual(blockConflict);
    expect(() => decodeReceipt({ operation: "applyBlockBatch", result: conflict })).toThrow();
    expect(() => decodeReceipt({ ...blockConflict, operation: "updatePage" })).toThrow();
    const found = { status: "found", receipt: blockConflict };
    expect(decodeLookupResult(found)).toEqual(found);
    expect(() => decodeLookupResult({ status: "found" })).toThrow();
  });

  it("keeps conflicts bounded to summaries without allowing page bodies", () => {
    const receipt = { operation: "updatePage", result: conflict };
    expect(decodeReceipt(receipt)).toEqual(receipt);
    for (const current of [
      { ...conflict.current, spaces: [space, space, space] },
      { ...conflict.current, pages: [page, page] },
      { ...conflict.current, pages: [{ ...page, blocks: [] }] },
    ]) {
      expect(() => decodeReceipt({ ...receipt, result: { ...conflict, current } })).toThrow();
    }
  });

  it("requires admission for an empty bootstrap list without defaulting read limits", () => {
    const input = { environmentId: writeContext.environmentId };
    expect(decodeList(input)).toEqual(input);
    expect(() => decodeList({ ...input, limit: 0 })).toThrow();
    const result = {
      items: [],
      defaultSpaceId: space.id,
      catalogRevision: 0,
      nextCursor: null,
      mutationAdmission: {
        epoch: "epoch-1",
        acceptsUntil: "2026-10-27T00:00:00.000Z",
        retainUntil: "2026-11-03T00:00:00.000Z",
      },
    };
    expect(decodeListResult(result)).toEqual(result);
    const { mutationAdmission: _admission, ...withoutAdmission } = result;
    expect(() => decodeListResult(withoutAdmission)).toThrow();
  });

  it("does not apply provisional service maxima to retained-request decoding", () => {
    const request = {
      operation: "applyBlockBatch",
      input: {
        ...batch,
        receiptEpoch: "retired-epoch",
        mutations: Array.from({ length: 101 }, (_, index) => ({
          kind: "insert",
          block: {
            id: `block-${index}`,
            parentId: null,
            order: `${index}`,
            type: "paragraph",
            version: 1,
            content: { runs: [{ text: "x".repeat(513), marks: [] }] },
          },
        })),
      },
    };
    expect(decodeRequest(request)).toEqual(request);
    const create = { operation: "createSpace", input: { ...writeContext, title: "x".repeat(513) } };
    expect(decodeRequest(create)).toEqual(create);
    const receipt = {
      operation: "createSpace",
      result: {
        status: "saved",
        ...acknowledgement,
        space: { ...space, title: create.input.title },
      },
    };
    expect(decodeReceipt(receipt)).toEqual(receipt);
  });

  it("decodes safe typed failures without accepting arbitrary limits or public messages", () => {
    const raw = {
      _tag: "SpaceLimitExceededError",
      limit: "maxMutationBytes",
      actual: 300_000,
      maximum: 262_144,
    };
    const error = decodeError(raw);
    expect(encodeError(error)).toEqual(raw);
    expect(error.message).toBe("The Spaces request exceeds maxMutationBytes.");
    expect(() => decodeError({ ...raw, limit: "maxAssets" })).toThrow();
    expect(() => decodeError({ ...raw, actual: -1 })).toThrow();
    expect(() => decodeError({ ...raw, message: "private request body" })).toThrow();
    expect(() => decodeCapability(true)).toThrow();
  });
});
