import { expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceCursor,
  SpacePageId,
  SpaceId,
  SpaceBlockId,
  type SpaceSearchResult,
  type SpaceReferenceResolveResult,
} from "@t2code/contracts/spaces";
import { SpaceReferenceController, type SpaceReferenceAccess } from "@t2code/client-runtime/spaces";
import { MobileSpaceReferenceNavigation } from "./references";

const environmentId = EnvironmentId.make("search-environment");
const page = {
  id: SpacePageId.make("page"),
  spaceId: SpaceId.make("space"),
  title: "Current title",
  revision: 1,
  rootOrder: "a",
  createdAt: "2026-10-26T00:00:00Z",
  updatedAt: "2026-10-26T00:00:00Z",
};
const ready: SpaceSearchResult = {
  catalogRevision: 1,
  items: [{ page, snippet: "Stored snippet" }],
  nextCursor: null,
};
function setup() {
  const live = {
    session: {} as object | null,
    sourceVersion: 0,
    canRead: true,
    capability: {
      version: 2,
      features: { search: true, referenceResolution: true },
    } as NonNullable<SpaceReferenceAccess["capability"]>,
  };
  const requests: unknown[] = [];
  let search: (input: unknown) => Promise<SpaceSearchResult> = async () => ready;
  let resolve: (
    input: import("@t2code/contracts/spaces").SpaceReferenceResolveInput,
  ) => Promise<SpaceReferenceResolveResult> = async (input) => ({
    status: "resolved",
    page: { ...page, id: input.target.kind === "page" ? input.target.pageId : page.id },
    ...(input.target.kind === "block" ? { blockId: input.target.blockId } : {}),
  });
  const controller = new SpaceReferenceController({
    environmentId,
    access: () => live,
    search: (input) => {
      requests.push(input);
      return search(input);
    },
    resolve: (input) => {
      requests.push(input);
      return resolve(input);
    },
  });
  return {
    controller,
    live,
    requests,
    search: (read: typeof search) => {
      search = read;
    },
    resolve: (read: typeof resolve) => {
      resolve = read;
    },
  };
}

it.each(["search", "resolve"] as const)(
  "settles 10,000 superseded %s prompts with one active transport and only the latest pending request",
  async (method) => {
    const h = setup();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    if (method === "search")
      h.search(async () => {
        if (++calls === 1) await release.promise;
        return ready;
      });
    else
      h.resolve(async (input) => {
        if (++calls === 1) await release.promise;
        return {
          status: "resolved",
          page: { ...page, id: input.target.kind === "page" ? input.target.pageId : page.id },
        };
      });
    const run = (id: number) =>
      method === "search"
        ? h.controller.search(`query${id}`)
        : h.controller.resolve({ kind: "page", pageId: SpacePageId.make(`page${id}`) });
    const first = run(0);
    const rest = Array.from({ length: 10_000 }, (_, i) => run(i + 1));
    const superseded = await Promise.all([first, ...rest.slice(0, -1)]);
    expect(superseded).toHaveLength(10_000);
    expect(
      superseded.every((result) =>
        method === "search" ? result?.status === "unavailable" : result === null,
      ),
    ).toBe(true);
    expect(calls).toBe(1);
    release.resolve();
    const latest = await rest.at(-1)!;
    expect(latest?.status).toBe(method === "search" ? "ready" : "resolved");
    expect(calls).toBe(2);
    expect(h.requests.at(-1)).toMatchObject(
      method === "search" ? { query: "query10000" } : { target: { pageId: "page10000" } },
    );
    h.controller.dispose();
  },
);

it("disposes and promptly settles active and pending reads without dispatching the pending transport", async () => {
  const h = setup();
  const release = Promise.withResolvers<SpaceSearchResult>();
  h.search(() => release.promise);
  const active = h.controller.search("first");
  const pending = h.controller.search("next");
  h.controller.dispose();
  expect((await active).status).toBe("unavailable");
  expect((await pending).status).toBe("unavailable");
  expect(h.requests).toHaveLength(1);
  release.resolve(ready);
  expect((await h.controller.search("after disposal")).status).toBe("unsupported");
  expect(h.requests).toHaveLength(1);
});

it("keeps library search independent of capture, preserves empty continuation and invalidates cursors with source, session and grants", async () => {
  for (const change of ["source", "session", "read", "search flag"] as const) {
    const h = setup();
    h.search(async () => ({
      catalogRevision: 1,
      items: [],
      nextCursor: SpaceCursor.make("opaque"),
    }));
    const window = await h.controller.search("needle");
    if (window.status !== "ready") throw Error(window.status);
    expect(h.controller.canCapture()).toBe(false);
    expect(window.result.items).toEqual([]);
    expect(h.requests).toHaveLength(1);
    const next = await window.next();
    expect(next.status).toBe("ready");
    expect(h.requests.at(-1)).toEqual({
      environmentId,
      query: "needle",
      limit: 20,
      cursor: "opaque",
    });
    if (next.status !== "ready") throw Error(next.status);
    if (change === "source") h.live.sourceVersion++;
    if (change === "session") h.live.session = {};
    if (change === "read") h.live.canRead = false;
    if (change === "search flag")
      h.live.capability = { version: 2, features: { referenceResolution: true } };
    expect(next.current()).toBe(false);
    expect(next.target(0)).toBeNull();
    expect((await next.next()).status).toBe("unavailable");
    expect(h.requests).toHaveLength(2);
    h.controller.dispose();
  }
});

it("refuses incompatible and missing optional capabilities before transport and reports building, unsupported and errors without retry", async () => {
  for (const version of [1, 3]) {
    const h = setup();
    h.live.capability = { ...h.live.capability, version };
    expect((await h.controller.search("needle")).status).toBe("unsupported");
    expect(await h.controller.resolve({ kind: "page", pageId: page.id })).toBeNull();
    expect(h.requests).toEqual([]);
  }
  for (const reason of ["building", "unsupported", "transport"]) {
    const h = setup();
    h.search(async () => {
      throw { reason };
    });
    expect((await h.controller.search("needle")).status).toBe(
      reason === "transport" ? "error" : reason,
    );
    expect(h.requests).toHaveLength(1);
  }
  const h = setup();
  h.live.capability = { version: 2, features: { referenceResolution: true } };
  expect((await h.controller.search("needle")).status).toBe("unsupported");
  expect(h.requests).toEqual([]);
  h.live.capability = { version: 2, features: { search: true, referenceResolution: true } };
  expect((await h.controller.search("😀".repeat(64))).status).toBe("invalid-query");
  expect(h.requests).toEqual([]);
});

it("retains selected reference metadata through invalidation, rejects late targets and active native input, then opens only latest current identity", async () => {
  const h = setup();
  const replies: ReturnType<typeof Promise.withResolvers<SpaceReferenceResolveResult>>[] = [];
  let entered = Promise.withResolvers<void>();
  h.resolve(() => {
    const reply = Promise.withResolvers<SpaceReferenceResolveResult>();
    replies.push(reply);
    entered.resolve();
    return reply.promise;
  });
  let canNavigate = true,
    sourceCurrent = true;
  const opened: unknown[] = [];
  const model = new MobileSpaceReferenceNavigation({
    current: () => canNavigate,
    open: (target) => opened.push(target),
  });
  const first = { environmentId, target: { kind: "page" as const, pageId: page.id } };
  model.select(first, () => sourceCurrent);
  const pending = model.open(h.controller, environmentId);
  const latest = {
    environmentId,
    target: { kind: "block" as const, blockId: SpaceBlockId.make("latest") },
  };
  model.select(latest, () => sourceCurrent);
  await pending;
  expect(model.getSnapshot().selection).toBe(latest);
  expect(opened).toEqual([]);
  replies[0]!.resolve({ status: "resolved", page });
  entered = Promise.withResolvers<void>();
  const next = model.open(h.controller, environmentId);
  await entered.promise;
  canNavigate = false;
  replies[1]!.resolve({ status: "resolved", page, blockId: latest.target.blockId });
  await next;
  expect(opened).toEqual([]);
  expect(model.getSnapshot().error).toContain("unavailable");
  canNavigate = true;
  const stale = model.open(h.controller, environmentId);
  sourceCurrent = false;
  replies[2]!.resolve({ status: "resolved", page, blockId: latest.target.blockId });
  await stale;
  expect(model.getSnapshot().selection).toBe(latest);
  expect(opened).toEqual([]);
  sourceCurrent = true;
  const current = model.open(h.controller, environmentId);
  replies[3]!.resolve({
    status: "merged",
    page: { ...page, id: SpacePageId.make("moved-page"), spaceId: SpaceId.make("moved-space") },
    requestedBlockId: latest.target.blockId,
    blockId: SpaceBlockId.make("survivor"),
  });
  await current;
  expect(opened).toEqual([
    { environmentId, spaceId: "moved-space", pageId: "moved-page", blockId: "survivor" },
  ]);
  const removed = model.open(h.controller, environmentId);
  model.dispose();
  await removed;
  replies[4]!.resolve({ status: "resolved", page, blockId: latest.target.blockId });
  expect(opened).toHaveLength(1);
});

it("rebinds mounted navigation metadata after cleanup and refuses a stale destination environment before transport", async () => {
  const h = setup();
  const opened: unknown[] = [];
  const model = new MobileSpaceReferenceNavigation({
    current: () => true,
    open: (target) => opened.push(target),
  });
  const selection = { environmentId, target: { kind: "page" as const, pageId: page.id } };
  const cleanup = model.mount();
  model.select(selection, () => true);
  cleanup();
  await model.open(h.controller, environmentId);
  expect(h.requests).toEqual([]);
  const stop = model.mount();
  await model.open(h.controller, EnvironmentId.make("stale-environment"));
  expect(h.requests).toEqual([]);
  expect(model.getSnapshot().selection).toBe(selection);
  await model.open(h.controller, environmentId);
  expect(opened).toEqual([{ environmentId, spaceId: page.spaceId, pageId: page.id }]);
  stop();
  h.controller.dispose();
});
