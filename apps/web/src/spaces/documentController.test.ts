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

function hydratingDocuments() {
  const started = deferred<void>();
  const loaded = deferred<SpaceDocumentDraft | null>();
  let revision = 1;
  const revisions: number[] = [];
  const documents = new SpaceDocumentControllers((target) =>
    controller(
      target,
      {
        getPage: async () => ({ ...metadata(), page: { ...metadata().page, revision } }),
        readBlocks: async (input) => {
          revisions.push(input.revision);
          return {
            revision: input.revision,
            blocks: [block(`revision-${input.revision}`)],
            nextCursor: null,
          };
        },
      },
      () => {
        started.resolve();
        return loaded.promise;
      },
    ),
  );
  return {
    documents,
    started,
    loaded,
    revisions,
    setRevision: (value: number) => {
      revision = value;
    },
  };
}

describe("Spaces document controller lifecycle", () => {
  it("reacquires the current revision after the last view closes during initial hydration", async () => {
    const { documents, started, loaded, revisions, setRevision } = hydratingDocuments();
    const initial = documents.open(key);
    await started.promise;
    initial.release();
    setRevision(2);
    const reconnected = documents.open(key);
    loaded.resolve(null);
    await initial.ready;
    const current = await reconnected.ready;
    expect(revisions).toEqual([1, 2]);
    expect(current.session.getSnapshot()).toMatchObject({
      baseRevision: 2,
      blocks: [block("revision-2")],
    });
    initial.release();
    const panel = documents.open(key);
    expect(await panel.ready).toBe(current);
    reconnected.release();
    panel.release();
  });
  it("reclaims resident capacity when first opens are interrupted before hydration completes", async () => {
    const loaded = deferred<SpaceDocumentDraft | null>();
    const documents = new SpaceDocumentControllers((target) =>
      controller(target, {}, () => loaded.promise),
    );
    const interrupted = [];
    for (let i = 0; i < 9; i++) {
      const opened = documents.open({ ...key, pageId: SpacePageId.make(`interrupted-${i}`) });
      opened.release();
      interrupted.push(opened.ready);
    }
    loaded.resolve(null);
    await expect(Promise.all(interrupted)).resolves.toHaveLength(9);
  });
  it("keeps shared hydration for a remaining owner and retains its later dirty draft", async () => {
    const { documents, started, loaded, revisions, setRevision } = hydratingDocuments();
    const route = documents.open(key);
    const panel = documents.open(key);
    await started.promise;
    route.release();
    setRevision(2);
    const remounted = documents.open(key);
    loaded.resolve(null);
    const current = await panel.ready;
    expect(await remounted.ready).toBe(current);
    await route.ready;
    expect(revisions).toEqual([1]);
    expect(current.session.getSnapshot().baseRevision).toBe(1);
    await current.refresh();
    expect(current.session.getSnapshot().baseRevision).toBe(2);
    expect(current.editorWindow().completeParents).toContain(null);
    current.session.apply([{ kind: "replace", block: block("retained local draft") }]);
    await current.session.persistDraft();
    panel.release();
    remounted.release();
    const reopened = documents.open(key);
    expect(await reopened.ready).toBe(current);
    expect(revisions).toEqual([1, 2]);
    expect(current.session.getSnapshot()).toMatchObject({
      dirty: true,
      blocks: [block("retained local draft")],
    });
    reopened.release();
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

it("reserves hydration and both shared edit/save owners without leaking capacity through release or a stale release", async () => {
  const h = hydratingDocuments();
  const opening = h.documents.open(key);
  await h.started.promise;
  expect(() => h.documents.reserve(key.environmentId, [key.pageId])).toThrow("finish loading");
  h.loaded.resolve(null);
  const doc = await opening.ready;
  const second = h.documents.open(key);
  await second.ready;
  const release = h.documents.reserve(key.environmentId, [key.pageId]);
  opening.release();
  expect(() => doc.session.apply([{ kind: "replace", block: block("blocked") }])).toThrow(
    "reserved",
  );
  await expect(doc.save()).rejects.toThrow("reserved");
  expect(() => h.documents.acquire(key)).toThrow("reserved");
  release();
  const nextReservation = h.documents.reserve(key.environmentId, [key.pageId]);
  release();
  expect(() => doc.open()).toThrow("reserved");
  nextReservation();
  second.release();
  for (let i = 0; i < 8; i++) {
    const owner = h.documents.open({
      ...key,
      pageId: SpacePageId.make(`clean-after-reservation-${i}`),
    });
    await owner.ready;
    owner.release();
  }
});

it("retains a failed open lease and reacquires after reservation release without a late failed-owner cleanup releasing the new view", async () => {
  const documents = new SpaceDocumentControllers((target) => controller(target));
  const release = documents.reserve(key.environmentId, [key.pageId]);
  const blocked = documents.open(key);
  await expect(blocked.ready).rejects.toThrow("reserved");
  release();
  const retried = documents.open(key);
  const doc = await retried.ready;
  blocked.release();
  const panel = documents.open(key);
  expect(await panel.ready).toBe(doc);
  retried.release();
  doc.session.apply([{ kind: "replace", block: block("new owner draft") }]);
  await doc.session.persistDraft();
  panel.release();
  const reopened = documents.open(key);
  expect(await reopened.ready).toBe(doc);
  expect(doc.session.getSnapshot().blocks).toEqual([block("new owner draft")]);
  reopened.release();
});

it("retains dirty content and visibly gates a refused structural refresh while refreshing later clean residents", async () => {
  let revision = 1;
  const documents = new SpaceDocumentControllers((target) =>
    controller(target, {
      getPage: async () => ({
        ...metadata(),
        page: { ...metadata().page, id: target.pageId, revision },
      }),
      readBlocks: async () => ({ revision, blocks: [block("server")], nextCursor: null }),
    }),
  );
  const other = { ...key, pageId: SpacePageId.make("other-clean") };
  const a = documents.open(key),
    b = documents.open(other);
  const dirty = await a.ready,
    clean = await b.ready;
  dirty.session.apply([{ kind: "replace", block: block("retained dirty") }]);
  await dirty.session.persistDraft();
  const unlock = documents.reserve(key.environmentId, [key.pageId, other.pageId], true);
  revision = 2;
  try {
    await expect(
      documents.refreshStructure(key.environmentId, [key.pageId, other.pageId]),
    ).rejects.toThrow();
  } finally {
    unlock();
  }
  expect(clean.session.getSnapshot().baseRevision).toBe(2);
  expect(clean.getSnapshot().error).toBeNull();
  expect(dirty.getSnapshot().error).toBeInstanceOf(Error);
  expect(dirty.session.getSnapshot()).toMatchObject({
    dirty: true,
    blocks: [block("retained dirty")],
  });
  a.release();
  b.release();
});
