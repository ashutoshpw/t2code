import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t2code/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { createSpacePageNavigationFactory } from "@t2code/client-runtime/spaces";
import type { SpacePageListResult } from "@t2code/contracts/spaces";
import { SpacePageFocusOwner } from "./SpacePageTree.focus";
import {
  SpaceBlockId,
  SpaceCursor,
  SpaceId,
  SpacePageId,
  SpaceReceiptEpoch,
} from "@t2code/contracts/spaces";
import type { SpaceNavigationWindow } from "@t2code/client-runtime/spaces";
import { spacePageTreeRows } from "./SpacePageTree.logic";

const spaceId = SpaceId.make("space");
const timestamp = "2026-10-27T00:00:00Z";
const page = (id: string, parent: string | null = null) => ({
  id: SpacePageId.make(id),
  spaceId,
  title: id,
  revision: 1,
  rootOrder: parent ? null : "rank",
  location: parent
    ? {
        kind: "child" as const,
        spaceId,
        parentPageId: SpacePageId.make(parent),
        ownerBlockId: SpaceBlockId.make(`owner-${id}`),
      }
    : { kind: "root" as const, spaceId, order: "rank" },
  createdAt: timestamp,
  updatedAt: timestamp,
});
function window(
  parent: string | null,
  items: ReturnType<typeof page>[],
  options: { cursor?: string; next?: string; error?: string } = {},
): SpaceNavigationWindow {
  return {
    parentPageId: parent ? SpacePageId.make(parent) : null,
    path: parent ? [SpacePageId.make(parent)] : [],
    cursor: options.cursor ? SpaceCursor.make(options.cursor) : undefined,
    pending: false,
    error: options.error ?? null,
    data: {
      space: {
        id: spaceId,
        title: "Space",
        revision: 1,
        rootOrderRevision: 1,
        isDefault: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      items,
      catalogRevision: 1,
      mutationAdmission: {
        epoch: SpaceReceiptEpoch.make("epoch"),
        acceptsUntil: timestamp,
        retainUntil: timestamp,
      },
      nextCursor: options.next ? SpaceCursor.make(options.next) : null,
    },
  };
}

describe("Space page navigation rows", () => {
  it("keeps expanded children and their window controls before the next sibling, without orphan rows", () => {
    const root = window(null, [page("parent"), page("sibling")], { next: "root-next" });
    const children = window("parent", [page("child", "parent")], { next: "children-next" });
    const unavailable = window("child", [page("stale-grandchild", "child")], {
      error: "Refresh this window.",
    });
    const orphan = window("not-in-current-window", [page("unreachable", "not-in-current-window")]);
    const rows = spacePageTreeRows([orphan, unavailable, children, root]);
    expect(
      rows.map((row) =>
        row.kind === "page"
          ? [row.page.id, row.depth, row.expanded]
          : [row.window.parentPageId, row.depth, "controls"],
      ),
    ).toEqual([
      ["parent", 0, true],
      ["child", 1, true],
      ["child", 2, "controls"],
      ["parent", 1, "controls"],
      ["sibling", 0, false],
      [null, 0, "controls"],
    ]);
    expect(rows[2]).toMatchObject({ parentTitle: "child", window: { error: unavailable.error } });
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    const collapsed = spacePageTreeRows([root, orphan]);
    expect(collapsed.filter((row) => row.kind === "page").map((row) => row.page.id)).toEqual([
      "parent",
      "sibling",
    ]);
    expect(collapsed.map((row) => row.key)).toContain(rows[0]!.key);
  });

  it("retains a window's control identity on an empty terminal continuation and page identity on rename", () => {
    const parent = page("parent");
    const root = window(null, [parent]);
    const first = spacePageTreeRows([
      root,
      window("parent", [page("child", "parent")], { next: "next" }),
    ]);
    const next = spacePageTreeRows([
      window(null, [{ ...parent, title: "Renamed" }]),
      window("parent", [], { cursor: "next" }),
    ]);
    expect(next[0]?.key).toBe(first[0]?.key);
    expect(next.at(-1)).toMatchObject({
      kind: "window",
      key: first.at(-1)!.key,
      parentTitle: "Renamed",
      window: { cursor: "next", data: { items: [], nextCursor: null } },
    });
    expect(next).toHaveLength(2);
  });
});

it("rejects obsolete scroll completion and reissues current keyed navigation after catalog replacement", async () => {
  const registry = AtomRegistry.make();
  const sources = Atom.family((_parent: string) =>
    Atom.make<AsyncResult.AsyncResult<SpacePageListResult, unknown>>(AsyncResult.initial()).pipe(
      Atom.setIdleTTL(0),
    ),
  );
  const navigation = createSpacePageNavigationFactory({
    registry,
    pages: ({ input }) => sources(input.parentPageId ?? "root"),
  })({ environmentId: EnvironmentId.make("destination"), spaceId, version: 2, maxRows: 20 });
  const stop = navigation.subscribe(() => {});
  const roots = Array.from({ length: 20 }, (_, index) => page(`root-${index}`));
  const root = window(null, roots, { next: "next-root" }).data!;
  registry.set(sources("root"), AsyncResult.success(root));
  navigation.expand(null, roots[0]!.id);
  registry.set(
    sources(roots[0]!.id),
    AsyncResult.success(
      window(
        roots[0]!.id,
        Array.from({ length: 20 }, (_, index) => page(`child-${index}`, roots[0]!.id)),
        { next: "next-children" },
      ).data!,
    ),
  );
  let rows = spacePageTreeRows(navigation.getSnapshot().windows);
  const sourceKey = rows[22]!.key;
  const destinationKey = rows[41]!.key;
  const scrolls: {
    key: string;
    index: number;
    resolve: () => void;
  }[] = [];
  const events: string[] = [];
  const focused: string[] = [];
  const pending: (string | null)[] = [];
  const scroll = (index: number) => {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
      resolve = complete;
    });
    scrolls.push({ key: rows[index]!.key, index, resolve });
    events.push(`scroll:${rows[index]!.key}`);
    return promise;
  };
  const list = {
    rows: () => rows,
    containsFocus: () => true,
    scrollToItem: (item: (typeof rows)[number]) => scroll(rows.indexOf(item)),
    cancelScroll: () => events.push("cancel"),
    focus: (key: string) => focused.push(key),
  };
  const owner = new SpacePageFocusOwner({
    epoch: navigation.getSnapshot,
    pending: (key) => pending.push(key),
  });
  owner.attach(list);
  try {
    const obsolete = owner.request(destinationKey);
    expect(scrolls[0]).toMatchObject({ index: 41, key: destinationKey });
    registry.set(sources("root"), AsyncResult.success({ ...root, catalogRevision: 2 }));
    rows = spacePageTreeRows(navigation.getSnapshot().windows);
    expect(rows.findIndex((row) => row.key === sourceKey)).toBe(1);
    expect(rows.findIndex((row) => row.key === destinationKey)).toBe(20);
    scrolls[0]!.resolve();
    await obsolete;
    expect(focused).toEqual([]);

    owner.invalidate();
    const replacement = owner.revalidate(navigation.getSnapshot(), rows);
    expect(events.slice(-2)).toEqual(["cancel", `scroll:${destinationKey}`]);
    expect(scrolls[1]).toMatchObject({ index: 20, key: destinationKey });
    registry.set(sources("root"), AsyncResult.success({ ...root, catalogRevision: 3 }));
    rows = spacePageTreeRows(navigation.getSnapshot().windows);
    owner.invalidate();
    const currentData = owner.revalidate(navigation.getSnapshot(), rows);
    expect(events.slice(-2)).toEqual(["cancel", `scroll:${destinationKey}`]);
    expect(scrolls[2]).toMatchObject({ index: 20, key: destinationKey });
    scrolls[1]!.resolve();
    await replacement;
    expect(focused).toEqual([]);
    const newest = owner.request(sourceKey);
    expect(events.slice(-2)).toEqual(["cancel", `scroll:${sourceKey}`]);
    expect(scrolls[3]).toMatchObject({ index: 1, key: sourceKey });
    scrolls[3]!.resolve();
    await newest;
    scrolls[2]!.resolve();
    await currentData;
    expect(focused).toEqual([sourceKey]);
    expect(pending.at(-1)).toBeNull();

    const detached = owner.request(destinationKey);
    owner.attach(null);
    expect(events.at(-1)).toBe("cancel");
    scrolls[4]!.resolve();
    await detached;
    expect(focused).toEqual([sourceKey]);
  } finally {
    owner.attach(null);
    stop();
    registry.dispose();
  }
});
