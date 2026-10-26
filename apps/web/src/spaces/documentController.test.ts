import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t2code/contracts";
import type { SpaceDocumentDraft, SpaceDraftStore } from "@t2code/client-runtime/spaces";
import {
  SpaceBlockId,
  SpaceId,
  SpacePageId,
  SpaceReceiptEpoch,
  SpaceCursor,
  type SpacePageGetResult,
  type SpaceReadBlocksResult,
} from "@t2code/contracts/spaces";
import {
  SpaceDocumentController,
  SpaceDocumentControllers,
  type SpaceDocumentPorts,
} from "./documentController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const key = { environmentId: EnvironmentId.make("env"), pageId: SpacePageId.make("page") };
const block = (text: string) => ({
  id: SpaceBlockId.make("a"),
  parentId: null,
  order: "00000000000000000000000000000001",
  type: "paragraph",
  version: 1,
  content: { runs: [{ text, marks: [] }] },
});
function metadata(): SpacePageGetResult {
  const now = "2026-10-26T00:00:00.000Z";
  return {
    page: {
      id: key.pageId,
      spaceId: SpaceId.make("space"),
      title: "Page",
      revision: 1,
      rootOrder: "1",
      createdAt: now,
      updatedAt: now,
    },
    space: {
      id: SpaceId.make("space"),
      title: "Space",
      revision: 1,
      rootOrderRevision: 1,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    },
    mutationAdmission: {
      epoch: SpaceReceiptEpoch.make("epoch"),
      acceptsUntil: now,
      retainUntil: now,
    },
  };
}
function controller(
  target = key,
  ports: Partial<SpaceDocumentPorts> = {},
  load: SpaceDraftStore["load"] = async () => null,
) {
  return new SpaceDocumentController(
    target,
    {
      adapter: {
        getMutationAdmission: async () => metadata().mutationAdmission,
        save: async () => {
          throw new Error("No backend configured in controller lifecycle test");
        },
        lookupReceipt: async () => {
          throw new Error("No backend configured in controller lifecycle test");
        },
      },
      drafts: { load, write: async () => {} },
      createMutationId: () => "mutation",
      maxLoadedBlocks: 100,
      maxMutations: 100,
    },
    {
      getPage: async () => metadata(),
      readBlocks: async () => ({
        revision: 1,
        blocks: [block("server")],
        nextCursor: SpaceCursor.make("next"),
      }),
      windowLimit: () => 100,
      ...ports,
    },
  );
}

describe("Spaces document controller lifecycle", () => {
  it("uses the current window when a reconnect overlaps initial draft hydration", async () => {
    const started = deferred<void>();
    const loaded = deferred<SpaceDocumentDraft | null>();
    let revision = 1;
    const document = controller(
      key,
      {
        getPage: async () => ({ ...metadata(), page: { ...metadata().page, revision } }),
        readBlocks: async (input) => ({
          revision: input.revision,
          blocks: [block(`revision-${input.revision}`)],
          nextCursor: null,
        }),
      },
      () => {
        started.resolve();
        return loaded.promise;
      },
    );
    const initial = document.open();
    await started.promise;
    document.invalidate();
    revision = 2;
    const reconnected = document.open();
    loaded.resolve(null);
    await Promise.all([initial, reconnected]);
    expect(document.session.getSnapshot()).toMatchObject({
      baseRevision: 2,
      blocks: [block("revision-2")],
    });
  });
  it("deduplicates route/panel hydration, isolates environments and releases only clean unused documents", async () => {
    const loaded = deferred<SpaceReadBlocksResult>();
    let reads = 0;
    const documents = new SpaceDocumentControllers((target) =>
      controller(target, {
        readBlocks: () => {
          reads++;
          return loaded.promise;
        },
      }),
    );
    const route = documents.acquire(key);
    const panel = documents.acquire(key);
    expect(route).toBe(panel);
    const opening = route.open();
    expect(panel.open()).toBe(opening);
    expect(() => route.session.apply([{ kind: "replace", block: block("early") }])).toThrow(
      "Hydrate",
    );
    loaded.resolve({ revision: 1, blocks: [block("loaded")], nextCursor: null });
    await opening;
    expect(reads).toBe(1);
    const otherKey = { ...key, environmentId: EnvironmentId.make("other") };
    const other = documents.acquire(otherKey);
    expect(other).not.toBe(route);
    documents.release(key, route);
    route.session.apply([{ kind: "replace", block: block("retained") }]);
    documents.release(key, panel);
    expect(documents.acquire(key)).toBe(route);
    await route.session.persistDraft();
    documents.release(otherKey, other);
    const cleanKey = { ...key, pageId: SpacePageId.make("clean") };
    const clean = documents.acquire(cleanKey);
    await clean.open();
    documents.release(cleanKey, clean);
    expect(documents.acquire(cleanKey)).not.toBe(clean);
  });
  it("ignores stale reads and prevents dirty window replacement", async () => {
    const stale = deferred<SpaceReadBlocksResult>();
    let reads = 0;
    const document = controller(key, {
      readBlocks: async () => {
        if (++reads === 2) return stale.promise;
        return {
          revision: 1,
          blocks: [block(reads === 1 ? "initial" : "current")],
          nextCursor: null,
        };
      },
    });
    await document.open();
    const old = document.refresh();
    const current = document.refresh();
    await current;
    stale.resolve({ revision: 1, blocks: [block("stale")], nextCursor: null });
    await old;
    expect(document.session.getSnapshot().blocks).toEqual([block("current")]);
    document.session.apply([{ kind: "replace", block: block("draft") }]);
    expect(() => document.refresh()).toThrow("Resolve");
    expect(() => document.next()).toThrow("Resolve");
    await document.session.persistDraft();
  });
  it("replaces one bounded window explicitly and refuses a ninth resident dirty document", async () => {
    const inputs: unknown[] = [];
    const document = controller(key, {
      windowLimit: () => 20,
      readBlocks: async (input) => {
        inputs.push(input);
        return {
          revision: 1,
          blocks: [block(input.cursor ? "second" : "first")],
          nextCursor: input.cursor ? null : SpaceCursor.make("cursor"),
        };
      },
    });
    await document.open();
    await document.next();
    expect(document.session.getSnapshot().blocks).toEqual([block("second")]);
    expect(inputs[1]).toMatchObject({ cursor: "cursor", limit: 20, revision: 1 });
    await document.refresh();
    expect(document.session.getSnapshot().blocks).toEqual([block("first")]);
    const documents = new SpaceDocumentControllers((target) => controller(target));
    for (let i = 0; i < 8; i++) {
      const target = { ...key, pageId: SpacePageId.make(`page-${i}`) };
      const item = documents.acquire(target);
      await item.open();
      item.session.apply([{ kind: "replace", block: block(`draft-${i}`) }]);
      await item.session.persistDraft();
      documents.release(target, item);
    }
    expect(() => documents.acquire(key)).toThrow("Close or resolve");
    expect(
      documents.acquire({ ...key, pageId: SpacePageId.make("page-0") }).session.getSnapshot()
        .blocks,
    ).toEqual([block("draft-0")]);
  });
});
