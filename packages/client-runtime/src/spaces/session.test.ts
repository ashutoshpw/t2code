import { EnvironmentId } from "@t2code/contracts";
import { SpaceBlockId, SpacePageId, type SpaceBlock } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import {
  SpaceDocumentSession,
  SpaceDocumentSessionRegistry,
  type SpaceDocumentDraft,
  type SpaceDraftStore,
  type SpaceSaveRequest,
  type SpaceSaveResult,
  type SpaceSessionAdapter,
  type SpaceSessionOptions,
} from "./index.ts";

const key = {
  environmentId: EnvironmentId.make("environment-1"),
  pageId: SpacePageId.make("page-1"),
};
function paragraph(text: string, id = "a"): SpaceBlock {
  return {
    id: SpaceBlockId.make(id),
    parentId: null,
    order: id,
    type: "paragraph",
    version: 1,
    content: { runs: [{ text, marks: [] }] },
  };
}
function harness(adapter: SpaceSessionAdapter, load: SpaceDraftStore["load"] = async () => null) {
  const writes: (SpaceDocumentDraft | null)[] = [];
  let nextId = 0;
  const options: SpaceSessionOptions = {
    adapter,
    drafts: {
      load,
      write: async (_key, draft) => {
        writes.push(draft);
      },
    },
    createMutationId: () => `mutation-${++nextId}`,
    maxLoadedBlocks: 3,
    maxMutations: 6,
  };
  return { options, writes, session: new SpaceDocumentSession(key, options) };
}
const noReceipt: SpaceSessionAdapter["lookupReceipt"] = async () => ({ status: "unknown" });

describe("SpaceDocumentSession", () => {
  it("hydrates before writes and shares one environment/page session across subscribed views", async () => {
    const loaded = Promise.withResolvers<SpaceDocumentDraft | null>();
    const { options } = harness(
      { save: async () => ({ status: "saved", revision: 2 }), lookupReceipt: noReceipt },
      () => loaded.promise,
    );
    const registry = new SpaceDocumentSessionRegistry();
    const pageView = registry.get(key, options);
    const panelView = registry.get(key, options);
    expect(panelView).toBe(pageView);
    expect(
      registry.get({ ...key, environmentId: EnvironmentId.make("environment-2") }, options),
    ).not.toBe(pageView);
    const hydration = pageView.hydrate({ revision: 1, blocks: [paragraph("server")] });
    expect(() => panelView.apply([{ kind: "replace", block: paragraph("too early") }])).toThrow(
      "Hydrate",
    );
    loaded.resolve(null);
    await hydration;
    const observed: SpaceBlock[][] = [];
    const unsubscribe = panelView.subscribe(() => {
      observed.push([...panelView.getSnapshot().blocks]);
    });
    expect(registry.release(key)).toBe(false);
    pageView.apply([{ kind: "replace", block: paragraph("shared") }]);
    expect(observed.at(-1)).toEqual([paragraph("shared")]);
    await pageView.save();
    expect(panelView.getSnapshot().status).toBe("saved");
    unsubscribe();
    expect(registry.release(key)).toBe(true);
  });

  it.each([false, true])(
    "recovers hydration after a transient load failure (draft: %s)",
    async (restoreDraft) => {
      const draft: SpaceDocumentDraft = {
        version: 1,
        key,
        baseRevision: 1,
        generation: 1,
        memberIds: [SpaceBlockId.make("a")],
        blocks: [paragraph("local draft")],
        mutations: [{ kind: "replace", block: paragraph("local draft") }],
        pending: null,
      };
      let loads = 0;
      const { session } = harness(
        { save: async () => ({ status: "saved", revision: 2 }), lookupReceipt: noReceipt },
        async () => {
          if (++loads === 1) throw new Error("storage unavailable");
          return restoreDraft ? draft : null;
        },
      );
      const window = { revision: 1, blocks: [paragraph("server")] };
      await expect(session.hydrate(window)).rejects.toThrow("storage unavailable");
      expect(session.getSnapshot().hydrated).toBe(false);
      await session.hydrate(window);
      expect(session.getSnapshot()).toMatchObject({
        hydrated: true,
        status: restoreDraft ? "draft" : "saved",
        blocks: [paragraph(restoreDraft ? "local draft" : "server")],
        persistenceError: null,
      });
      expect(session.canRelease()).toBe(!restoreDraft);
      if (restoreDraft) {
        await session.discardDraft(window);
        expect(session.canRelease()).toBe(true);
      }
    },
  );

  it("sends explicit loaded mutations and never infers unloaded deletions from a bounded window", async () => {
    const requests: SpaceSaveRequest[] = [];
    const { session } = harness({
      save: async (request) => {
        requests.push(request);
        return { status: "saved", revision: 2 };
      },
      lookupReceipt: noReceipt,
    });
    await session.hydrate({ revision: 1, blocks: [paragraph("visible")] });
    expect(() =>
      session.apply([{ kind: "delete", blockId: SpaceBlockId.make("unloaded") }]),
    ).toThrow("unloaded");
    session.apply([{ kind: "replace", block: paragraph("edited") }]);
    session.apply([{ kind: "delete", blockId: SpaceBlockId.make("a") }]);
    expect(session.getSnapshot().blocks).toEqual([]);
    expect(session.getSnapshot().memberIds).toEqual(["a"]);
    expect(() =>
      session.replaceWindow({ revision: 1, blocks: [paragraph("elsewhere", "z")] }),
    ).toThrow("draft");
    await session.save();
    expect(requests[0]?.mutations).toEqual([
      { kind: "replace", block: paragraph("edited") },
      { kind: "delete", blockId: "a" },
    ]);
    expect(session.getSnapshot().memberIds).toEqual([]);
    session.replaceWindow({ revision: 2, blocks: [paragraph("elsewhere", "z")] });
    expect(session.getSnapshot().blocks).toEqual([paragraph("elsewhere", "z")]);
  });

  it("preserves opaque blocks and marks while saving an editable neighbor", async () => {
    const requests: SpaceSaveRequest[] = [];
    const { session } = harness({
      save: async (request) => {
        requests.push(request);
        return { status: "saved", revision: 2 };
      },
      lookupReceipt: noReceipt,
    });
    const opaque = {
      ...paragraph("", "future"),
      type: "future_container",
      version: 9,
      content: { references: ["a"] },
      extra: { keep: true },
    };
    const marked = {
      ...paragraph("", "marked"),
      parentId: opaque.id,
      content: { runs: [{ text: "keep", marks: [{ type: "future", version: 7, target: "a" }] }] },
    };
    await session.hydrate({ revision: 1, blocks: [opaque, marked, paragraph("editable")] });
    expect(() => session.apply([{ kind: "replace", block: { ...opaque, content: {} } }])).toThrow(
      "read-only",
    );
    expect(() =>
      session.apply([{ kind: "replace", block: paragraph("stripped", "marked") }]),
    ).toThrow("read-only");
    session.apply([{ kind: "replace", block: paragraph("edited neighbor") }]);
    await session.save();
    expect(session.getSnapshot().blocks).toEqual([opaque, marked, paragraph("edited neighbor")]);
    expect(requests[0]?.mutations).toEqual([
      { kind: "replace", block: paragraph("edited neighbor") },
    ]);
  });

  it("rejects oversized and invalid container batches atomically", async () => {
    const { session } = harness({
      save: async () => ({ status: "saved", revision: 2 }),
      lookupReceipt: noReceipt,
    });
    await session.hydrate({ revision: 1, blocks: [paragraph("first")] });
    expect(() =>
      session.apply([
        { kind: "insert", block: { ...paragraph("child", "b"), parentId: SpaceBlockId.make("a") } },
      ]),
    ).toThrow("list item");
    expect(() =>
      session.apply(["b", "c", "d"].map((id) => ({ kind: "insert", block: paragraph(id, id) }))),
    ).toThrow("limit");
    expect(session.getSnapshot().blocks).toEqual([paragraph("first")]);
    expect(session.getSnapshot().dirty).toBe(false);
  });

  it("bounds repeated text edits by their pending payload rather than keystroke count", async () => {
    const requests: SpaceSaveRequest[] = [];
    const { options } = harness({
      save: async (request) => {
        requests.push(request);
        return { status: "saved", revision: 2 };
      },
      lookupReceipt: noReceipt,
    });
    const session = new SpaceDocumentSession(key, { ...options, maxMutations: 1 });
    await session.hydrate({ revision: 1, blocks: [paragraph("server")] });
    for (const text of ["s", "so", "som", "some", "some text"])
      session.apply([{ kind: "replace", block: paragraph(text) }]);
    await session.save();
    expect(requests[0]?.mutations).toEqual([{ kind: "replace", block: paragraph("some text") }]);
    expect(session.getSnapshot()).toMatchObject({
      status: "saved",
      generation: 5,
      blocks: [paragraph("some text")],
    });
  });

  it("retains only the latest queued draft while a durable write is in flight", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writes: (SpaceDocumentDraft | null)[] = [];
    const { options } = harness({
      save: async () => ({ status: "saved", revision: 2 }),
      lookupReceipt: noReceipt,
    });
    const session = new SpaceDocumentSession(key, {
      ...options,
      maxMutations: 1,
      drafts: {
        load: async () => null,
        write: async (_key, draft) => {
          writes.push(draft);
          if (writes.length === 1) {
            started.resolve();
            await release.promise;
          }
        },
      },
    });
    await session.hydrate({ revision: 1, blocks: [paragraph("server")] });
    session.apply([{ kind: "replace", block: paragraph("first") }]);
    await started.promise;
    for (const text of ["n", "ne", "new", "newest"])
      session.apply([{ kind: "replace", block: paragraph(text) }]);
    const persisted = session.persistDraft();
    release.resolve();
    await persisted;
    expect(writes).toHaveLength(2);
    expect(writes.at(-1)?.blocks).toEqual([paragraph("newest")]);
  });

  it("persists the pending request before sending and a late ack clears only the sent generation", async () => {
    const started = Promise.withResolvers<SpaceSaveRequest>();
    const reply = Promise.withResolvers<SpaceSaveResult>();
    const requests: SpaceSaveRequest[] = [];
    const { session, writes } = harness({
      save: async (request) => {
        expect(writes.at(-1)?.pending).toEqual(request);
        requests.push(request);
        if (requests.length === 1) {
          started.resolve(request);
          return reply.promise;
        }
        return { status: "saved", revision: 3 };
      },
      lookupReceipt: noReceipt,
    });
    await session.hydrate({ revision: 1, blocks: [paragraph("server")] });
    session.apply([{ kind: "replace", block: paragraph("first draft") }]);
    const saving = session.save();
    const sent = await started.promise;
    session.apply([{ kind: "replace", block: paragraph("typed during save") }]);
    expect(session.save()).toBe(saving);
    reply.resolve({ status: "saved", revision: 2 });
    await saving;
    expect(session.getSnapshot()).toMatchObject({
      status: "draft",
      dirty: true,
      generation: 2,
      baseRevision: 2,
      blocks: [paragraph("typed during save")],
    });
    expect(writes.at(-1)?.mutations).toEqual([
      { kind: "replace", block: paragraph("typed during save") },
    ]);
    await session.save();
    expect(requests[1]).toMatchObject({
      baseRevision: 2,
      generation: 2,
      mutations: [{ kind: "replace", block: paragraph("typed during save") }],
    });
    expect(requests[1]?.mutationId).not.toBe(sent.mutationId);
    expect(writes.at(-1)).toBeNull();
  });

  it("retains a conflicted draft and requires an explicit discard before refreshing the window", async () => {
    const { session, writes } = harness({
      save: async () => ({ status: "conflict", revision: 9 }),
      lookupReceipt: noReceipt,
    });
    await session.hydrate({ revision: 1, blocks: [paragraph("old")] });
    session.apply([{ kind: "replace", block: paragraph("local draft") }]);
    await session.save();
    expect(session.getSnapshot()).toMatchObject({
      status: "conflict",
      conflictRevision: 9,
      baseRevision: 1,
      dirty: true,
      blocks: [paragraph("local draft")],
    });
    expect(writes.at(-1)?.blocks).toEqual([paragraph("local draft")]);
    await expect(session.save()).rejects.toThrow("conflict");
    await session.discardDraft({ revision: 9, blocks: [paragraph("new server")] });
    expect(session.getSnapshot()).toMatchObject({ status: "saved", dirty: false, baseRevision: 9 });
    expect(writes.at(-1)).toBeNull();
  });

  it("looks up an uncertain receipt before identical retry and retains edits after that request", async () => {
    const lookup = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<{ readonly status: "absent" }>();
    const requests: SpaceSaveRequest[] = [];
    const { session } = harness({
      save: async (request) => {
        requests.push(request);
        if (requests.length === 1) throw new Error("connection lost");
        return { status: "saved", revision: 2 };
      },
      lookupReceipt: async () => {
        lookup.resolve();
        return receipt.promise;
      },
    });
    await session.hydrate({ revision: 1, blocks: [paragraph("server")] });
    session.apply([{ kind: "replace", block: paragraph("sent") }]);
    await expect(session.save()).rejects.toThrow("connection lost");
    expect(session.getSnapshot().status).toBe("uncertain");
    await expect(session.discardDraft({ revision: 1, blocks: [] })).rejects.toThrow("receipt");
    session.apply([{ kind: "replace", block: paragraph("newer") }]);
    const retry = session.save();
    await lookup.promise;
    expect(requests).toHaveLength(1);
    receipt.resolve({ status: "absent" });
    await retry;
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(session.getSnapshot()).toMatchObject({
      status: "draft",
      dirty: true,
      baseRevision: 2,
      blocks: [paragraph("newer")],
    });
  });

  it("recovers a durable uncertain request after restart and acknowledges its receipt without resending", async () => {
    const first = harness({
      save: async () => {
        throw new Error("lost acknowledgement");
      },
      lookupReceipt: noReceipt,
    });
    await first.session.hydrate({ revision: 1, blocks: [paragraph("server")] });
    first.session.apply([{ kind: "replace", block: paragraph("committed remotely") }]);
    await expect(first.session.save()).rejects.toThrow("lost acknowledgement");
    first.session.apply([{ kind: "replace", block: paragraph("newer local draft") }]);
    await first.session.persistDraft();
    const restoredDraft = first.writes.at(-1)!;
    let sends = 0;
    const recovered = harness(
      {
        save: async () => {
          sends++;
          return { status: "saved", revision: 3 };
        },
        lookupReceipt: async (request) => {
          expect(request).toEqual(restoredDraft.pending);
          return { status: "saved", revision: 2 };
        },
      },
      async () => restoredDraft,
    );
    await recovered.session.hydrate({ revision: 2, blocks: [paragraph("committed remotely")] });
    expect(recovered.session.getSnapshot().status).toBe("uncertain");
    await recovered.session.save();
    expect(sends).toBe(0);
    expect(recovered.session.getSnapshot()).toMatchObject({
      status: "draft",
      baseRevision: 2,
      blocks: [paragraph("newer local draft")],
    });
  });

  it("preserves pending identity when receipt status is unknown", async () => {
    let sends = 0;
    let diskFull = false;
    let receiptAbsent = false;
    const { options } = harness({
      save: async () => {
        sends++;
        throw new Error("offline");
      },
      lookupReceipt: async () => ({ status: receiptAbsent ? "absent" : "unknown" }),
    });
    const session = new SpaceDocumentSession(key, {
      ...options,
      drafts: {
        ...options.drafts,
        write: async (...args) => {
          if (diskFull) throw new Error("disk full");
          await options.drafts.write(...args);
        },
      },
    });
    await session.hydrate({ revision: 1, blocks: [paragraph("server")] });
    session.apply([{ kind: "replace", block: paragraph("draft") }]);
    await expect(session.save()).rejects.toThrow("offline");
    const pending = session.getSnapshot().pending;
    await session.save();
    expect(sends).toBe(1);
    expect(session.getSnapshot()).toMatchObject({ status: "uncertain", pending, dirty: true });
    receiptAbsent = true;
    diskFull = true;
    await expect(session.save()).rejects.toThrow("disk full");
    expect(sends).toBe(1);
    expect(session.getSnapshot()).toMatchObject({ status: "uncertain", pending, dirty: true });
    await expect(session.discardDraft({ revision: 1, blocks: [] })).rejects.toThrow("receipt");
  });

  it.each([false, true])(
    "recovers an unsent save after disk full (earlier durable pending: %s)",
    async (durablePending) => {
      let sends = 0;
      let lookups = 0;
      let diskFull = true;
      let stored: SpaceDocumentDraft | null = null;
      let pendingStarted = false;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { options } = harness({
        save: async (request) => {
          expect(request.generation).toBe(2);
          expect(request.mutations.at(-1)).toEqual({
            kind: "replace",
            block: paragraph("newer typing"),
          });
          sends++;
          return { status: "saved", revision: 2 };
        },
        lookupReceipt: async () => {
          lookups++;
          return { status: "unknown" };
        },
      });
      const session = new SpaceDocumentSession(key, {
        ...options,
        drafts: {
          load: async () => null,
          write: async (_key, draft) => {
            if (draft?.pending && !pendingStarted) {
              pendingStarted = true;
              started.resolve();
              await release.promise;
              if (durablePending) {
                stored = draft;
                return;
              }
            }
            if (diskFull) {
              if (durablePending && pendingStarted) diskFull = false;
              throw new Error("disk full");
            }
            stored = draft;
          },
        },
      });
      await session.hydrate({ revision: 1, blocks: [paragraph("server")] });
      session.apply([{ kind: "replace", block: paragraph("keep me") }]);
      const saving = session.save();
      await started.promise;
      session.apply([{ kind: "replace", block: paragraph("newer typing") }]);
      release.resolve();
      await expect(saving).rejects.toThrow("disk full");
      expect(sends).toBe(0);
      expect(session.getSnapshot()).toMatchObject({
        dirty: true,
        pending: null,
        generation: 2,
        status: "draft",
        blocks: [paragraph("newer typing")],
      });
      if (!durablePending) {
        diskFull = false;
        await session.persistDraft();
      }
      expect(stored).toMatchObject({
        pending: null,
        generation: 2,
        blocks: [paragraph("newer typing")],
      });
      const recovered = harness(options.adapter, async () => stored);
      await recovered.session.hydrate({ revision: 1, blocks: [paragraph("server")] });
      await recovered.session.save();
      expect(sends).toBe(1);
      expect(lookups).toBe(0);
      expect(recovered.session.getSnapshot()).toMatchObject({ status: "saved", dirty: false });
      await session.discardDraft({ revision: 2, blocks: [paragraph("newer typing")] });
      expect(session.canRelease()).toBe(true);
    },
  );
});
