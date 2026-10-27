import { describe, expect, it } from "vite-plus/test";
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
