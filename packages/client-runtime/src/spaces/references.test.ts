import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ComposerContextId, EnvironmentId, SpaceContextSelector } from "@t2code/contracts";
import {
  SpaceBlockId,
  SpaceId,
  SpacePageId,
  type SpaceSearchResult,
} from "@t2code/contracts/spaces";
import { SpaceReferenceController, supportsSpaceContextCapture } from "./references.ts";

const isSelector = Schema.is(SpaceContextSelector);
const environmentId = EnvironmentId.make("env");
const page = {
  id: SpacePageId.make("current-page"),
  spaceId: SpaceId.make("current-space"),
  title: "Stored label",
  revision: 2,
  rootOrder: "a",
  createdAt: "2026-10-26T00:00:00Z",
  updatedAt: "2026-10-26T00:00:00Z",
};
function setup() {
  let session: object | null = {};
  let canRead = true;
  let capability = {
    version: 2,
    features: {
      search: true as const,
      referenceResolution: true as const,
      contextCapture: true as const,
    },
  };
  const calls: unknown[] = [];
  let reply: SpaceSearchResult = {
    catalogRevision: 1,
    items: [
      { page, snippet: "Page hit" },
      { page, blockId: SpaceBlockId.make("block"), snippet: "Block hit" },
    ],
    nextCursor: null,
  };
  const controller = new SpaceReferenceController({
    environmentId,
    access: () => ({ session, sourceVersion: 0, canRead, capability, inlineContext: true }),
    search: async (input) => {
      calls.push(input);
      return reply;
    },
    resolve: async (input) => {
      calls.push(input);
      return {
        status: "merged",
        requestedBlockId: SpaceBlockId.make("old"),
        blockId: SpaceBlockId.make("survivor"),
        page,
      };
    },
  });
  return {
    controller,
    calls,
    setReply: (value: SpaceSearchResult) => {
      reply = value;
    },
    disconnect: () => {
      session = null;
    },
    reconnect: () => {
      session = {};
    },
    deny: () => {
      canRead = false;
    },
    searchOnly: () => {
      capability = { version: 2, features: { search: true } as typeof capability.features };
    },
    old: () => {
      capability = { version: 2, features: {} as typeof capability.features };
    },
  };
}
it("requires an explicit capture flag on compatible inline-context servers", async () => {
  expect(supportsSpaceContextCapture({ version: 2 }, true)).toBe(false);
  expect(
    supportsSpaceContextCapture({ version: 3, features: { contextCapture: true } }, true),
  ).toBe(false);
  expect(
    supportsSpaceContextCapture({ version: 2, features: { contextCapture: true } }, false),
  ).toBe(false);
  expect(
    supportsSpaceContextCapture({ version: 2, features: { contextCapture: true } }, true),
  ).toBe(true);
  const h = setup();
  h.searchOnly();
  expect(h.controller.canSearch()).toBe(true);
  expect(h.controller.canCapture()).toBe(false);
  const window = await h.controller.search("word");
  if (window.status !== "ready") throw Error(window.status);
  expect(window.target(0)).toEqual({ kind: "page", pageId: page.id });
  expect(window.select(0, ComposerContextId.make("denied-capture"), true)).toBeNull();
  h.calls.length = 0;
  h.old();
  expect((await h.controller.search("word")).status).toBe("unsupported");
  expect(h.calls).toEqual([]);
});
it("maps mixed hits to persisted selectors without capturing or trusting link hints", async () => {
  const h = setup();
  const result = await h.controller.search("word");
  expect(result.status).toBe("ready");
  if (result.status !== "ready") return;
  expect(h.calls).toEqual([{ environmentId, query: "word", limit: 20 }]);
  expect(result.select(0, ComposerContextId.make("child-page"), true)?.includeChildPages).toBe(
    true,
  );
  expect(result.select(1, ComposerContextId.make("child-block"), true)?.includeChildPages).toBe(
    true,
  );
  const { prepareSpaceContextSend } = await import("./sendContext.ts");
  for (const index of [0, 1]) {
    const selected = result.select(index, ComposerContextId.make("opted-in"), true)!;
    let captured: import("@t2code/contracts").SpaceContextCaptureInput | undefined;
    const pending = prepareSpaceContextSend({
      environmentId,
      text: "[Selected](t2-context://v1/page/opted-in)",
      selectors: [selected],
      access: () => ({ session: h.controller, canRead: true, supportsCapture: true }),
      isCurrentDraft: () => true,
      capture: async (input) => {
        captured = input;
        return { status: "unavailable" };
      },
    });
    await expect(pending).rejects.toThrow("source is unavailable");
    expect(captured).toEqual({
      environmentId,
      contextId: selected.contextId,
      includeChildPages: true,
      target:
        selected.kind === "page"
          ? { kind: "page", pageId: selected.pageId }
          : { kind: "block", blockId: selected.blockId },
    });
  }
  const p = result.select(0, ComposerContextId.make("p"));
  const b = result.select(1, ComposerContextId.make("b"));
  expect(p).toMatchObject({
    selection: "current",
    kind: "page",
    pageId: page.id,
    includeChildPages: false,
  });
  expect(b).toMatchObject({
    selection: "current",
    kind: "block",
    blockId: "block",
    includeChildPages: false,
  });
  expect(b).not.toHaveProperty("snapshot");
  expect(b).not.toHaveProperty("pageId");
  h.reconnect();
  expect(result.select(0, ComposerContextId.make("x"))).toBeNull();
});
it("bounds query before transport and preserves empty continuation without filling it", async () => {
  const h = setup();
  for (const q of ["", "a ".repeat(9), "😀".repeat(64)]) await h.controller.search(q);
  expect(h.calls).toEqual([]);
  const { SpaceCursor } = await import("@t2code/contracts/spaces");
  h.setReply({ catalogRevision: 1, items: [], nextCursor: SpaceCursor.make("opaque") });
  const first = await h.controller.search("word");
  if (first.status !== "ready") throw Error(first.status);
  expect(first.result.items).toEqual([]);
  expect(first.result.nextCursor).toBe("opaque");
  expect(h.calls).toHaveLength(1);
  await first.next();
  expect(h.calls.at(-1)).toEqual({ environmentId, query: "word", limit: 20, cursor: "opaque" });
  h.setReply({
    catalogRevision: 1,
    items: Array.from({ length: 21 }, () => ({ page, snippet: "" })),
    nextCursor: null,
  });
  expect((await h.controller.search("word")).status).toBe("unavailable");
  h.setReply({
    catalogRevision: 1,
    items: [{ page, snippet: "x".repeat(32768) }],
    nextCursor: null,
  });
  expect((await h.controller.search("word")).status).toBe("unavailable");
});
it("uses current merged identity and revokes already resolved targets on access changes", async () => {
  const h = setup();
  const target = { kind: "block" as const, blockId: SpaceBlockId.make("old") };
  const result = await h.controller.resolve(target);
  expect(result?.current()).toEqual({
    environmentId,
    spaceId: page.spaceId,
    pageId: page.id,
    blockId: "survivor",
  });
  expect(h.calls).toEqual([{ environmentId, target }]);
  h.deny();
  expect(result?.current()).toBeNull();
  expect(await h.controller.resolve(target)).toBeNull();
  expect(h.calls).toHaveLength(1);
});
it("discards deferred search and source replies after connection replacement", async () => {
  let session: object = {};
  let deliver!: (value: SpaceSearchResult) => void;
  const controller = new SpaceReferenceController({
    environmentId,
    access: () => ({
      sourceVersion: 0,
      session,
      canRead: true,
      capability: {
        version: 2,
        features: { search: true, contextCapture: true, referenceResolution: true },
      },
      inlineContext: true,
    }),
    search: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
    resolve: async () => ({ status: "deleted" }),
  });
  const pending = controller.search("word");
  await Promise.resolve();
  session = {};
  deliver({ catalogRevision: 1, items: [{ page, snippet: "" }], nextCursor: null });
  expect((await pending).status).toBe("unavailable");
  expect(await controller.resolve({ kind: "page", pageId: page.id })).toBeNull();
});

it("reports building and unsupported failures explicitly without automatic retries", async () => {
  const { SpaceSearchUnavailableError } = await import("@t2code/contracts/spaces");
  for (const reason of ["building", "unsupported"] as const) {
    let calls = 0;
    const session = {};
    const controller = new SpaceReferenceController({
      environmentId,
      access: () => ({
        sourceVersion: 0,
        session,
        canRead: true,
        capability: { version: 2, features: { search: true, contextCapture: true } },
        inlineContext: true,
      }),
      search: async () => {
        calls++;
        throw new SpaceSearchUnavailableError({ reason });
      },
      resolve: async () => ({ status: "unavailable" }),
    });
    expect((await controller.search("word")).status).toBe(reason);
    expect(calls).toBe(1);
  }
});
it("only sends selected referenced IDs through the accepted send boundary", async () => {
  const { prepareSpaceContextSend } = await import("./sendContext.ts");
  const h = setup();
  const window = await h.controller.search("word");
  if (window.status !== "ready") throw Error(window.status);
  const selected = window.select(0, ComposerContextId.make("selected"))!;
  const removed = window.select(1, ComposerContextId.make("removed"))!;
  const requests: string[] = [];
  const session = {};
  const context = await prepareSpaceContextSend({
    environmentId,
    text: "[Page](t2-context://v1/terminal/selected)",
    selectors: [selected, removed],
    isCurrentDraft: () => true,
    access: () => ({ session, canRead: true, supportsCapture: true }),
    capture: async (input) => {
      requests.push(input.contextId);
      return {
        status: "captured",
        record: {
          version: 1,
          kind: "page",
          contextId: input.contextId,
          label: "Stored label",
          environmentId,
          spaceId: page.spaceId,
          pageId: page.id,
          title: page.title,
          snapshot: {
            version: 1,
            includeChildPages: false,
            truncated: false,
            text: "captured only at send",
            contentHash: `sha256:${"a".repeat(64)}`,
            sources: [
              { environmentId, spaceId: page.spaceId, pageId: page.id, revision: 2, blockIds: [] },
            ],
          },
        },
      };
    },
  });
  expect(requests).toEqual(["selected"]);
  expect(context?.records.map((record) => record.contextId)).toEqual(["selected"]);
});
it("revokes deferred source locations on replacement and does not navigate trashed or deleted sources", async () => {
  let session: object = {};
  let deliver!: (value: import("@t2code/contracts/spaces").SpaceReferenceResolveResult) => void;
  const options: ConstructorParameters<typeof SpaceReferenceController>[0] = {
    environmentId,
    access: () => ({
      sourceVersion: 0,
      session,
      canRead: true,
      capability: { version: 2, features: { referenceResolution: true } },
      inlineContext: false,
    }),
    search: async () => ({ catalogRevision: 1, items: [], nextCursor: null }),
    resolve: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  };
  let controller = new SpaceReferenceController(options);
  const target = { kind: "page" as const, pageId: page.id };
  const pending = controller.resolve(target);
  session = {};
  deliver({ status: "resolved", page });
  expect(await pending).toBeNull();
  controller = new SpaceReferenceController(options);
  for (const status of ["trashed", "deleted", "unavailable"] as const) {
    const request = controller.resolve(target);
    deliver(status === "trashed" ? { status, pageId: page.id } : { status });
    expect(await request).toBeNull();
  }
  const first = controller.resolve(target);
  deliver({ status: "resolved", page });
  const location = await first;
  expect(location?.current()).not.toBeNull();
  const second = controller.resolve(target);
  expect(location?.current()).toBeNull();
  deliver({ status: "resolved", page });
  expect((await second)?.current()?.pageId).toBe(page.id);
});

it("admits exact canonical query ceilings and bounds Unicode selector labels", async () => {
  const h = setup();
  h.setReply({
    catalogRevision: 1,
    items: [{ page: { ...page, title: "😀".repeat(120) }, snippet: "" }],
    nextCursor: null,
  });
  const exact = await h.controller.search("x".repeat(254));
  expect(exact.status).toBe("ready");
  if (exact.status !== "ready") throw Error(exact.status);
  const selector = exact.select(0, ComposerContextId.make("unicode"));
  expect(isSelector(selector)).toBe(true);
  expect(selector?.label).not.toContain("\ufffd");
  expect((await h.controller.search("x".repeat(255))).status).toBe("invalid-query");
  expect(h.calls).toHaveLength(1);
});
it("serializes search and skips obsolete queued queries without filling result windows", async () => {
  const session = {};
  const calls: string[] = [];
  let deliver!: (result: SpaceSearchResult) => void;
  const controller = new SpaceReferenceController({
    environmentId,
    access: () => ({
      sourceVersion: 0,
      session,
      canRead: true,
      capability: { version: 2, features: { search: true, contextCapture: true } },
      inlineContext: true,
    }),
    search: (input) => {
      calls.push(input.query);
      return calls.length === 1
        ? new Promise((resolve) => {
            deliver = resolve;
          })
        : Promise.resolve({ catalogRevision: 1, items: [], nextCursor: null });
    },
    resolve: async () => ({ status: "deleted" }),
  });
  const first = controller.search("first");
  await Promise.resolve();
  const second = controller.search("second");
  const third = controller.search("third");
  expect(calls).toEqual(["first"]);
  deliver({ catalogRevision: 1, items: [], nextCursor: null });
  const results = await Promise.all([first, second, third]);
  expect(calls).toEqual(["first", "third"]);
  expect(results.map((result) => result.status)).toEqual(["unavailable", "unavailable", "ready"]);
});

it.each([false, true])(
  "keeps library search usable without capture support (inline context %s)",
  async (inlineContext) => {
    const session = {};
    const requests: unknown[] = [];
    const controller = new SpaceReferenceController({
      environmentId,
      access: () => ({
        session,
        sourceVersion: 0,
        canRead: true,
        inlineContext,
        capability: { version: 2, features: { search: true } },
      }),
      search: async (input) => {
        requests.push(input);
        return {
          catalogRevision: 1,
          items: [{ page, snippet: "Library result" }],
          nextCursor: null,
        };
      },
      resolve: async () => ({ status: "unavailable" }),
    });
    const window = await controller.search("library");
    if (window.status !== "ready") throw Error(window.status);
    expect(requests).toEqual([{ environmentId, query: "library", limit: 20 }]);
    expect(window.target(0)).toEqual({ kind: "page", pageId: page.id });
    expect(window.select(0, ComposerContextId.make("unsupported"))).toBeNull();
    expect(controller.canCapture()).toBe(false);
  },
);
