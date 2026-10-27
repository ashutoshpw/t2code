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
import {
  SpaceDocumentSession,
  type SpaceDraftStore,
  type SpaceDocumentDraft,
} from "@t2code/client-runtime/spaces";
import { MobileSpaceDocuments } from "./documents";
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
function pageSession(
  pageId = target.pageId,
  drafts: SpaceDraftStore = { load: async () => null, write: async () => {} },
) {
  return new SpaceDocumentSession(
    { environmentId: target.environmentId, pageId },
    {
      drafts,
      adapter: {
        getMutationAdmission: async () => located().mutationAdmission,
        save: async () => {
          throw new Error("Reader tests must not write to the server");
        },
        lookupReceipt: async () => {
          throw new Error("Reader tests must not resolve a fabricated receipt");
        },
      },
      createMutationId: () => "unused-reader-mutation",
      maxLoadedBlocks: 100,
      maxMutations: 100,
    },
  );
}
function setup(access?: SpacesReadAccess) {
  const inputs: SpaceReadBlocksInput[] = [];
  const responses: SpaceReadBlocksResult[] = [];
  let locations = 0;
  const reader = new SpacesPageReader(target, {
    session: pageSession(),
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
      session: pageSession(),
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
      session: pageSession(),
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
      session: pageSession(),
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
        session: pageSession(SpacePageId.make("moved-page")),
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

function retainedDraft(pageId = target.pageId): SpaceDocumentDraft {
  const key = { environmentId: target.environmentId, pageId };
  const block = {
    id: SpaceBlockId.make("retained"),
    type: "paragraph",
    version: 1,
    parentId: null,
    order: "a",
    content: { runs: [{ text: "Local draft", marks: [] }] },
  };
  return {
    version: 1,
    key,
    baseRevision: 6,
    generation: 1,
    memberIds: [block.id],
    blocks: [block],
    mutations: [{ kind: "replace", block }],
    pending: {
      key,
      baseRevision: 6,
      generation: 1,
      mutationId: "uncertain-original",
      mutations: [{ kind: "replace", block }],
    },
  };
}

describe("mobile document ownership", () => {
  it("shares one hydration across two views and does not let a stale release retire the remaining owner", async () => {
    const loadStarted = Promise.withResolvers<void>();
    const hydrate = Promise.withResolvers<SpaceDocumentDraft | null>();
    let loads = 0;
    let bodyReads = 0;
    const bodySignal = Promise.withResolvers<AbortSignal>();
    const documents = new MobileSpaceDocuments(
      (page) =>
        new SpacesPageReader(page, {
          session: pageSession(page.pageId, {
            load: async () => {
              loads++;
              loadStarted.resolve();
              return hydrate.promise;
            },
            write: async () => {
              throw new Error("Viewing must not rewrite a draft");
            },
          }),
          access: { availability: "read-only", capability, current: () => true },
          locate: async () => located(),
          blocks: async (_input, currentSignal) => {
            bodyReads++;
            bodySignal.resolve(currentSignal);
            return { revision: 7, blocks: [], nextCursor: SpaceCursor.make("unloaded") };
          },
        }),
    );
    const first = documents.acquire(target);
    const second = documents.acquire({ ...target, spaceId: SpaceId.make("renamed-hint") });
    expect(first.reader).toBe(second.reader);
    const opening = first.reader.first();
    const otherOpening = second.reader.first();
    await loadStarted.promise;
    expect(second.reader.getSnapshot().window).toBeNull();
    expect(second.reader.getSnapshot().session.hydrated).toBe(false);
    first.release();
    first.release();
    expect((await bodySignal.promise).aborted).toBe(false);
    hydrate.resolve(retainedDraft());
    await Promise.all([opening, otherOpening]);
    expect(loads).toBe(1);
    expect(bodyReads).toBe(1);
    expect(second.reader.getSnapshot().window?.blocks).toEqual(retainedDraft().blocks);
    expect(second.reader.getSnapshot().session).toMatchObject({
      status: "uncertain",
      recoveryReason: "legacy-epoch-missing",
      pending: { mutationId: "uncertain-original" },
    });
    await second.reader.next();
    expect(bodyReads).toBe(1);
    second.release();
    const reopened = documents.acquire(target);
    expect(reopened.reader).toBe(second.reader);
    expect(reopened.reader.session.getSnapshot().pending?.mutationId).toBe("uncertain-original");
    first.release();
    reopened.release();
  });

  it("retains the canonical owner when the last view leaves during hydration and reconnects", async () => {
    const loadStarted = Promise.withResolvers<void>();
    const hydrate = Promise.withResolvers<SpaceDocumentDraft | null>();
    let loads = 0;
    let connection = 1;
    const documents = new MobileSpaceDocuments(
      (page) =>
        new SpacesPageReader(page, {
          session: pageSession(page.pageId, {
            load: async () => {
              loads++;
              loadStarted.resolve();
              return hydrate.promise;
            },
            write: async () => {
              throw new Error("Reader must retain this pending draft");
            },
          }),
          get access(): SpacesReadAccess {
            const owner = connection;
            return { availability: "read-only", capability, current: () => owner === connection };
          },
          locate: async () => located(),
          blocks: async () => ({ revision: 7, blocks: [], nextCursor: null }),
        }),
    );
    const old = documents.acquire(target);
    const oldOpening = old.reader.first();
    await loadStarted.promise;
    old.release();
    connection++;
    const current = documents.acquire(target);
    expect(current.reader).toBe(old.reader);
    const opening = current.reader.first();
    hydrate.resolve(retainedDraft());
    await Promise.all([oldOpening, opening]);
    expect(loads).toBe(1);
    expect(current.reader.getSnapshot().session.pending).toEqual(retainedDraft().pending);
    expect(current.reader.getSnapshot().window?.blocks).toEqual(retainedDraft().blocks);
    old.release();
    expect(current.reader.getSnapshot().location?.current()).not.toBeNull();
    current.release();
  });

  it("does not show a server window over a failed local draft load and permits an explicit retry", async () => {
    let failed = true;
    const session = pageSession(target.pageId, {
      load: async () => {
        if (failed) throw new Error("Corrupt retained draft");
        return retainedDraft();
      },
      write: async () => {},
    });
    const reader = new SpacesPageReader(target, {
      session,
      access: { availability: "read-only", capability, current: () => true },
      locate: async () => located(),
      blocks: async () => ({ revision: 7, blocks: [], nextCursor: null }),
    });
    await reader.first();
    expect(reader.getSnapshot().window).toBeNull();
    expect(reader.getSnapshot().session.persistenceError).toBeInstanceOf(Error);
    failed = false;
    await reader.first();
    expect(reader.getSnapshot().window?.blocks).toEqual(retainedDraft().blocks);
    expect(reader.session.getSnapshot().pending).toEqual(retainedDraft().pending);
  });

  it("refuses a ninth retained page without scanning or evicting hidden drafts", async () => {
    const loaded: string[] = [];
    const documents = new MobileSpaceDocuments(
      (page) =>
        new SpacesPageReader(page, {
          session: pageSession(page.pageId, {
            load: async (key) => {
              loaded.push(key.pageId);
              return retainedDraft(key.pageId);
            },
            write: async () => {},
          }),
          access: { availability: "read-only", capability, current: () => true },
          locate: async () => located(page.pageId),
          blocks: async () => ({ revision: 7, blocks: [], nextCursor: null }),
        }),
    );
    for (let index = 0; index < 8; index++) {
      const lease = documents.acquire({ ...target, pageId: SpacePageId.make(`page-${index}`) });
      await lease.reader.first();
      lease.release();
    }
    expect(() => documents.acquire(target)).toThrow("Close or resolve");
    expect(loaded).toHaveLength(8);
    const retained = documents.acquire({ ...target, pageId: SpacePageId.make("page-0") });
    expect(retained.reader.session.getSnapshot().pending?.mutationId).toBe("uncertain-original");
    retained.release();
  });
});
