import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceBlockId,
  SpaceCursor,
  SpaceId,
  SpacePageId,
  SpacePageGetResult,
  type SpaceCapability,
  type SpaceReadBlocksInput,
  type SpaceReadBlocksResult,
} from "@t2code/contracts/spaces";
import { spacesAvailability } from "@t2code/client-runtime/state/spaces";
import { SpacesPageReader, type SpacesReadAccess } from "./reader";

const target = {
  environmentId: EnvironmentId.make("remote"),
  spaceId: SpaceId.make("old-space"),
  pageId: SpacePageId.make("page"),
};
const capability: SpaceCapability = {
  version: 2,
  limits: {
    maxListRows: 20,
    maxListResponseBytes: 32768,
    maxBlockWindowBlocks: 2,
    maxBlockWindowResponseBytes: 4096,
    maxMutationNodes: 100,
    maxMutationBytes: 32768,
    maxBlockBytes: 32768,
    maxDepth: 16,
    maxPageBlocks: 1000,
    maxPageBytes: 1048576,
    maxIdBytes: 256,
    maxTitleBytes: 1024,
    maxOrderBytes: 64,
    maxCursorBytes: 1024,
    maxReceiptBytes: 32768,
    maxReceiptRows: 100,
    maxReceiptStorageBytes: 1048576,
    maxEpochRows: 10,
    receiptRetentionMs: 60000,
    cleanupBatchRows: 100,
  },
};
const decodePage = Schema.decodeUnknownSync(SpacePageGetResult);
function located(pageId = target.pageId) {
  const metadata = decodePage({
    page: {
      id: pageId,
      spaceId: "current-space",
      title: "Current title",
      revision: 7,
      rootOrder: "a",
      location: { kind: "root", spaceId: "current-space", order: "a" },
      createdAt: "2026-10-27T00:00:00.000Z",
      updatedAt: "2026-10-27T00:00:00.000Z",
    },
    space: {
      id: "current-space",
      title: "Current space",
      isDefault: true,
      revision: 1,
      rootOrderRevision: 1,
      createdAt: "2026-10-27T00:00:00.000Z",
      updatedAt: "2026-10-27T00:00:00.000Z",
    },
    mutationAdmission: {
      epoch: "epoch",
      acceptsUntil: "2026-10-28T00:00:00.000Z",
      retainUntil: "2026-10-29T00:00:00.000Z",
    },
  });
  return { ...metadata, ancestors: [], current: () => metadata };
}
function setup(access?: SpacesReadAccess) {
  const inputs: SpaceReadBlocksInput[] = [];
  const responses: SpaceReadBlocksResult[] = [];
  let locations = 0;
  const reader = new SpacesPageReader(target, {
    access: access ?? { availability: "read-only", capability, current: () => true },
    locate: async () => {
      locations++;
      return located();
    },
    blocks: async (input) => {
      inputs.push(input);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected read");
      return response;
    },
  });
  return { reader, inputs, responses, locations: () => locations };
}

describe("mobile Spaces page reader", () => {
  it("reads the observed revision, retains opaque payloads and continues empty windows only on request", async () => {
    const test = setup();
    test.responses.push({ revision: 7, blocks: [], nextCursor: SpaceCursor.make("next") });
    await test.reader.first();
    expect(test.reader.getSnapshot().window?.nextCursor).toBe("next");
    expect(test.inputs).toHaveLength(1);
    const opaque = {
      id: SpaceBlockId.make("future"),
      type: "future",
      version: 9,
      parentId: null,
      order: "a",
      content: { secretFormatting: ["keep", { nested: true }] },
      futureEnvelope: "retained",
    };
    test.responses.push({ revision: 7, blocks: [opaque], nextCursor: null });
    await test.reader.next();
    expect(test.inputs[1]).toEqual({
      environmentId: "remote",
      pageId: "page",
      revision: 7,
      limit: 2,
      cursor: "next",
    });
    expect(test.reader.getSnapshot().location?.page.spaceId).toBe("current-space");
    expect(test.reader.getSnapshot().window?.blocks).toEqual([opaque]);
    await test.reader.next();
    expect(test.inputs).toHaveLength(2);
  });

  it.each([
    { connected: false, capability, canRead: true, canOperate: true },
    { connected: true, capability: undefined, canRead: true, canOperate: true },
    { connected: true, capability: { ...capability, version: 3 }, canRead: true, canOperate: true },
    { connected: true, capability, canRead: false, canOperate: true },
  ])("refuses unavailable access before location or body reads: %j", async (input) => {
    const test = setup({
      availability: spacesAvailability(input),
      capability: input.capability,
      current: () => true,
    });
    await test.reader.first();
    expect(test.reader.getSnapshot().error).toBeTruthy();
    expect(test.locations()).toBe(0);
    expect(test.inputs).toEqual([]);
  });

  it("accepts a known v1 read without enabling writes or nested-location assumptions", async () => {
    const old = { ...capability, version: 1 };
    const test = setup({
      availability: spacesAvailability({
        connected: true,
        capability: old,
        canRead: true,
        canOperate: false,
      }),
      capability: old,
      current: () => true,
    });
    test.responses.push({ revision: 7, blocks: [], nextCursor: null });
    await test.reader.first();
    expect(test.reader.getSnapshot()).toMatchObject({
      error: null,
      loading: false,
      window: { revision: 7 },
    });
  });

  it("aborts a released read and cannot publish its late response over a new window", async () => {
    const pending = Promise.withResolvers<SpaceReadBlocksResult>();
    const started = Promise.withResolvers<AbortSignal>();
    let first = true;
    const reader = new SpacesPageReader(target, {
      access: { availability: "read-only", capability, current: () => true },
      locate: async () => located(),
      blocks: async (_input, signal) => {
        if (first) {
          first = false;
          started.resolve(signal);
          return pending.promise;
        }
        return { revision: 7, blocks: [], nextCursor: SpaceCursor.make("current") };
      },
    });
    const old = reader.first();
    const signal = await started.promise;
    reader.invalidate();
    expect(signal.aborted).toBe(true);
    await reader.first();
    pending.resolve({ revision: 7, blocks: [], nextCursor: SpaceCursor.make("stale") });
    await old;
    expect(reader.getSnapshot().window?.nextCursor).toBe("current");
  });

  it("does not request a body when current-location authority is lost", async () => {
    let reads = 0;
    const reader = new SpacesPageReader(target, {
      access: { availability: "read-only", capability, current: () => true },
      locate: async () => ({ ...located(), current: () => null }),
      blocks: async () => {
        reads++;
        return { revision: 7, blocks: [], nextCursor: null };
      },
    });
    await reader.first();
    expect(reads).toBe(0);
    expect(reader.getSnapshot().error).toContain("location changed");
  });

  it("drops a body after its connection or permission owner changes", async () => {
    const pending = Promise.withResolvers<SpaceReadBlocksResult>();
    const started = Promise.withResolvers<void>();
    let current = true;
    const reader = new SpacesPageReader(target, {
      access: { availability: "read-only", capability, current: () => current },
      locate: async () => located(),
      blocks: async () => {
        started.resolve();
        return pending.promise;
      },
    });
    const read = reader.first();
    await started.promise;
    current = false;
    pending.resolve({ revision: 7, blocks: [], nextCursor: null });
    await read;
    expect(reader.getSnapshot().window).toBeNull();
    reader.invalidate();
  });

  it.each(["revision", "bytes", "count"] as const)(
    "rejects a %s violation without exposing a partial body",
    async (violation) => {
      const test = setup();
      const block = {
        id: SpaceBlockId.make("opaque"),
        type: "future",
        version: 2,
        order: "a",
        parentId: null,
        content: { text: violation === "bytes" ? "x".repeat(4096) : "ok" },
      };
      test.responses.push({
        revision: violation === "revision" ? 8 : 7,
        blocks:
          violation === "count"
            ? [
                block,
                { ...block, id: SpaceBlockId.make("second") },
                { ...block, id: SpaceBlockId.make("third") },
              ]
            : [block],
        nextCursor: null,
      });
      await test.reader.first();
      expect(test.reader.getSnapshot().window).toBeNull();
      expect(test.reader.getSnapshot().error).toContain("read limit");
    },
  );

  it("reads a resolved moved block's current page without scanning for it", async () => {
    const inputs: SpaceReadBlocksInput[] = [];
    const reader = new SpacesPageReader(
      { ...target, blockId: SpaceBlockId.make("merged") },
      {
        access: { availability: "read-only", capability, current: () => true },
        locate: async () => ({
          ...located(SpacePageId.make("moved-page")),
          resolvedBlockId: SpaceBlockId.make("survivor"),
        }),
        blocks: async (input) => {
          inputs.push(input);
          return { revision: 7, blocks: [], nextCursor: SpaceCursor.make("more") };
        },
      },
    );
    await reader.first();
    expect(inputs.map((input) => input.pageId)).toEqual(["moved-page"]);
    expect(reader.getSnapshot().location?.resolvedBlockId).toBe("survivor");
    expect(reader.getSnapshot().window?.blocks).toEqual([]);
  });
});
