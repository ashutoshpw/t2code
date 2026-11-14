import { describe, expect, it } from "vite-plus/test";

import {
  MAX_REMOTE_PAGES,
  EMPTY_REMOTE_PAGES,
  foldPageChanges,
  spaceLiveAction,
  type SpaceLiveAction,
  type SpacePageLiveSignal,
} from "./livePage.ts";
import { SpaceId, SpacePageId } from "@t2code/contracts/spaces";

const signal = (over: Partial<SpacePageLiveSignal> = {}): SpacePageLiveSignal => ({
  changeSeq: 0,
  resyncSeq: 0,
  ...over,
});
const clean = { hydrated: true, busy: false, baseRevision: 3, metadataRevision: 3 };

describe("spaceLiveAction", () => {
  const rows: ReadonlyArray<
    readonly [
      string,
      SpacePageLiveSignal | null,
      SpacePageLiveSignal,
      Partial<typeof clean>,
      SpaceLiveAction,
    ]
  > = [
    ["unchanged signal", signal({ changeSeq: 1 }), signal({ changeSeq: 1 }), {}, "none"],
    [
      "not hydrated",
      null,
      signal({ changeSeq: 1, revision: 4, bodyRevision: 4 }),
      { hydrated: false },
      "none",
    ],
    [
      "busy document",
      null,
      signal({ changeSeq: 1, revision: 4, bodyRevision: 4 }),
      { busy: true },
      "hold",
    ],
    ["newer body", null, signal({ changeSeq: 1, revision: 4, bodyRevision: 4 }), {}, "body"],
    [
      "newer metadata only",
      null,
      signal({ changeSeq: 1, revision: 4, bodyRevision: 3 }),
      {},
      "metadata",
    ],
    ["own echo", null, signal({ changeSeq: 1, revision: 3, bodyRevision: 3 }), {}, "none"],
    ["resync", signal({ changeSeq: 1 }), signal({ changeSeq: 1, resyncSeq: 1 }), {}, "check"],
    ["resync while busy", null, signal({ resyncSeq: 1 }), { busy: true }, "hold"],
  ];
  it.each(rows)("%s", (_name, previous, next, state, expected) => {
    expect(spaceLiveAction(previous, next, { ...clean, ...state })).toBe(expected);
  });
});

describe("foldPageChanges", () => {
  const page = SpacePageId.make("p");
  const space = SpaceId.make("s");
  it("keeps the newest revisions and marks tree changes", () => {
    const first = foldPageChanges(EMPTY_REMOTE_PAGES, {
      type: "changed",
      pages: [{ id: page, spaceId: space, revision: 2, bodyRevision: 2 }],
      spaces: [],
    });
    expect(first.treeSeq).toBe(0);
    const second = foldPageChanges(first, {
      type: "changed",
      pages: [{ id: page, spaceId: space, revision: 3, bodyRevision: 2, tree: true }],
      spaces: [],
    });
    expect(second.pages.get(page)).toEqual({ revision: 3, bodyRevision: 2, seq: 2 });
    expect(second.treeSeq).toBe(2);
  });

  it("collapses to a resync past the page limit", () => {
    const pages = Array.from({ length: MAX_REMOTE_PAGES + 1 }, (_, index) => ({
      id: SpacePageId.make(`p${index}`),
      spaceId: space,
      revision: 1,
      bodyRevision: 1,
    }));
    const folded = foldPageChanges(EMPTY_REMOTE_PAGES, { type: "changed", pages, spaces: [] });
    expect(folded.pages.size).toBe(0);
    expect(folded.resyncs).toBe(1);
  });
});
