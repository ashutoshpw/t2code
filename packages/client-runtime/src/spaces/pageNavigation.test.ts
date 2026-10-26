import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceReceiptEpoch,
  SpaceBlockId,
  SpaceCursor,
  SpaceId,
  SpacePageId,
  SpaceCursorStaleError,
  type SpacePageListInput,
  type SpacePageListResult,
  type SpacePageSummary,
} from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { createSpacePageNavigationFactory } from "./pageNavigation.ts";

const environmentId = EnvironmentId.make("destination");
const spaceId = SpaceId.make("space");
const timestamp = "2026-10-26T00:00:00Z";
const admission = {
  epoch: SpaceReceiptEpoch.make("epoch"),
  acceptsUntil: timestamp,
  retainUntil: timestamp,
};
function page(id: string, parent: string | null = null): SpacePageSummary {
  return {
    id: SpacePageId.make(id),
    spaceId,
    title: id,
    revision: 0,
    rootOrder: parent ? null : "rank",
    location: parent
      ? {
          kind: "child",
          spaceId,
          ownerBlockId: SpaceBlockId.make(`owner-${id}`),
          parentPageId: SpacePageId.make(parent),
        }
      : { kind: "root", spaceId, order: "rank" },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
function window(
  items: readonly SpacePageSummary[],
  revision = 1,
  nextCursor: string | null = null,
): SpacePageListResult {
  return {
    items,
    catalogRevision: revision,
    nextCursor: nextCursor ? SpaceCursor.make(nextCursor) : null,
    mutationAdmission: admission,
    space: {
      id: spaceId,
      title: "Space",
      isDefault: true,
      revision: 0,
      rootOrderRevision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}
function setup(version: 1 | 2 = 2) {
  const registry = AtomRegistry.make();
  const sources = new Map<
    string,
    Atom.Writable<AsyncResult.AsyncResult<SpacePageListResult, unknown>>
  >();
  const requests: { environmentId: EnvironmentId; input: SpacePageListInput }[] = [];
  const key = (parent: SpacePageId | null, cursor?: SpaceCursor) =>
    `${parent ?? "root"}/${cursor ?? "first"}`;
  const factory = createSpacePageNavigationFactory({
    registry,
    pages: (request) => {
      requests.push(request);
      const input = request.input;
      const id = key(input.parentPageId ?? null, input.cursor);
      let atom = sources.get(id);
      if (!atom) {
        atom = Atom.make<AsyncResult.AsyncResult<SpacePageListResult, unknown>>(
          AsyncResult.initial(false),
        ).pipe(Atom.setIdleTTL(0));
        sources.set(id, atom);
      }
      return atom;
    },
  });
  const target = { environmentId, spaceId, version, maxRows: 20 };
  const navigation = factory(target);
  const source = (parent: SpacePageId | null = null, cursor?: SpaceCursor) =>
    sources.get(key(parent, cursor))!;
  const respond = (parent: SpacePageId | null, data: SpacePageListResult, cursor?: SpaceCursor) =>
    registry.set(source(parent, cursor), AsyncResult.success(data));
  const listeners = (atom: Atom.Atom<unknown>) =>
    registry.getNodes().get(atom)?.listeners.size ?? 0;
  return { registry, navigation, factory, target, source, respond, listeners, requests };
}

describe("SpacePageNavigation", () => {
  it("shares view leases, loads direct children only on expansion, and releases replaced/collapsed windows", () => {
    const h = setup();
    const same = h.factory({ ...h.target });
    expect(same).toBe(h.navigation);
    const stop = h.navigation.subscribe(() => {});
    const stopOther = same.subscribe(() => {});
    try {
      const parent = page("parent");
      h.respond(null, window([parent, page("other")]));
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]).toMatchObject({
        environmentId,
        input: { environmentId, spaceId, limit: 20 },
      });
      expect(h.requests[0]!.input).not.toHaveProperty("parentPageId");
      h.navigation.expand(null, parent.id);
      expect(h.requests.at(-1)?.input.parentPageId).toBe(parent.id);
      const child = page("child", "parent");
      h.respond(parent.id, window([child], 1, "next-children"));
      h.navigation.expand(parent.id, child.id);
      const childSource = h.source(child.id);
      h.respond(child.id, window([]));
      h.navigation.next(parent.id);
      expect(h.listeners(childSource)).toBe(0);
      expect(h.requests.at(-1)?.input).toMatchObject({
        parentPageId: parent.id,
        cursor: "next-children",
      });
      h.respond(
        parent.id,
        window([page("second-child", "parent")]),
        SpaceCursor.make("next-children"),
      );
      expect(h.navigation.getSnapshot().windows).toHaveLength(2);
      h.navigation.collapse(parent.id);
      expect(h.navigation.getSnapshot().windows).toHaveLength(1);
      h.respond(child.id, window([page("late", "child")]));
      expect(h.navigation.getSnapshot().windows).toHaveLength(1);
      stop();
      expect(h.listeners(h.source())).toBe(1);
      stopOther();
      expect(h.listeners(h.source())).toBe(0);
      expect(h.navigation.getSnapshot().windows).toEqual([]);
    } finally {
      stop();
      stopOther();
      h.registry.dispose();
    }
  });

  it("resets stale cursors and invalidates old selectors when a newer catalog is observed", () => {
    const h = setup();
    const stop = h.navigation.subscribe(() => {});
    try {
      h.respond(null, window([page("before")], 1, "old"));
      h.navigation.next(null);
      h.registry.set(
        h.source(null, SpaceCursor.make("old")),
        AsyncResult.failure(Cause.fail(new SpaceCursorStaleError({ revision: 2 }))),
      );
      expect(h.requests.at(-1)?.input.cursor).toBeUndefined();
      expect(h.navigation.getSnapshot().windows[0]?.data).toBeNull();
      h.respond(null, window([page("obsolete")], 1), SpaceCursor.make("old"));
      expect(h.navigation.getSnapshot().windows[0]?.data).toBeNull();
      h.respond(null, window([page("current")], 2));
      const current = SpacePageId.make("current");
      h.navigation.expand(null, current);
      h.respond(current, window([page("moved", "current")], 3));
      expect(h.navigation.getSnapshot().windows).toHaveLength(1);
      expect(h.requests.at(-1)?.input).not.toHaveProperty("parentPageId");
      h.respond(null, window([page("new-root")], 3));
      expect(h.navigation.getSnapshot().windows[0]?.data?.items[0]?.id).toBe("new-root");
      expect(h.listeners(h.source(current))).toBe(0);
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it("bounds live windows before issuing requests and frees capacity on collapse", () => {
    const h = setup();
    const stop = h.navigation.subscribe(() => {});
    try {
      const roots = Array.from({ length: 20 }, (_, i) => page(`page-${i}`));
      h.respond(null, window(roots));
      for (const root of roots.slice(0, 15)) h.navigation.expand(null, root.id);
      expect(h.navigation.getSnapshot().windows).toHaveLength(16);
      h.navigation.expand(null, roots[15]!.id);
      expect(h.requests).toHaveLength(16);
      expect(h.navigation.getSnapshot().error).toContain("Collapse");
      h.navigation.collapse(roots[0]!.id);
      h.navigation.expand(null, roots[15]!.id);
      expect(h.requests).toHaveLength(17);
      stop();
      for (const node of h.registry.getNodes().values()) expect(h.listeners(node.atom)).toBe(0);
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it("rejects oversized UTF8 windows and contradictory normalized locations without retaining them", () => {
    const h = setup();
    const stop = h.navigation.subscribe(() => {});
    try {
      const title = "界".repeat(Math.floor((2 * 1024 * 1024) / 3) + 1);
      expect(title.length).toBeLessThan(2 * 1024 * 1024);
      h.respond(null, window([{ ...page("large"), title }]));
      expect(h.navigation.getSnapshot().windows[0]?.data).toBeNull();
      expect(h.navigation.getSnapshot().windows[0]?.error).toContain("limit");
      expect(h.listeners(h.source())).toBe(0);
      h.navigation.refresh();
      h.respond(null, window([page("child", "a-parent")]));
      expect(h.navigation.getSnapshot().windows[0]?.data).toBeNull();
      expect(h.navigation.getSnapshot().windows[0]?.error).toContain("locations changed");
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it("waits for fresh v2 data when the query cache still contains v1 summaries", () => {
    const h = setup(1);
    const stopLegacy = h.navigation.subscribe(() => {});
    let stopCurrent = () => {};
    try {
      const { location: _location, ...legacy } = page("legacy");
      const oldWindow = window([legacy]);
      h.respond(null, oldWindow);
      h.registry.set(h.source(), AsyncResult.success(oldWindow, { waiting: true }));
      const current = h.factory({ ...h.target, version: 2 });
      stopCurrent = current.subscribe(() => {});
      expect(current.getSnapshot().windows[0]?.error).toBeNull();
      expect(current.getSnapshot().windows[0]?.pending).toBe(true);
      h.respond(null, window([page("legacy")], 2));
      expect(current.getSnapshot().windows[0]?.data?.items[0]?.location?.kind).toBe("root");
    } finally {
      stopLegacy();
      stopCurrent();
      h.registry.dispose();
    }
  });

  it("keeps v1 flat and does not request child selectors", () => {
    const h = setup(1);
    const stop = h.navigation.subscribe(() => {});
    try {
      const { location: _location, ...legacy } = page("legacy");
      h.respond(null, window([legacy]));
      h.navigation.expand(null, legacy.id);
      expect(h.requests).toHaveLength(1);
      expect(h.navigation.getSnapshot().windows[0]?.data?.items).toEqual([legacy]);
    } finally {
      stop();
      h.registry.dispose();
    }
  });
});
