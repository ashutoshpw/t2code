import { EnvironmentId, ThreadId } from "@t2code/contracts";
import {
  SpaceBlockId,
  SpaceCommentId,
  SpaceCommentThreadId,
  SpacePageId,
  type SpaceCommentThread,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerThreadCandidate } from "../composerThreadItems.ts";
import {
  commentRunsFromText,
  commentText,
  groupSpaceCommentThreads,
  spaceCommentDispatchLabel,
  spaceCommentThreadChoices,
  submitSpaceComment,
} from "./comments.ts";

const environmentId = EnvironmentId.make("env");
const thread = (id: string, over: Partial<SpaceCommentThread> = {}): SpaceCommentThread => ({
  id: SpaceCommentThreadId.make(id),
  pageId: SpacePageId.make("page"),
  blockId: SpaceBlockId.make(`block-${id}`),
  resolvedBlockId: SpaceBlockId.make(`block-${id}`),
  anchorState: "live",
  anchor: { kind: "block" },
  status: "open",
  resolvedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  revision: 1,
  comments: [],
  ...over,
});
const detached = (id: string): SpaceCommentThread => {
  const { resolvedBlockId: _gone, ...rest } = thread(id, { anchorState: "detached" });
  return rest;
};
const shell = (
  id: string,
  updatedAt: string,
  over: Partial<ComposerThreadCandidate> = {},
): ComposerThreadCandidate => ({
  environmentId,
  id: ThreadId.make(id),
  title: `Thread ${id}`,
  branch: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt,
  latestUserMessageAt: null,
  opens: null,
  archivedAt: null,
  lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  ...over,
});

describe("comment text", () => {
  it("round-trips one run and trims trailing whitespace", () => {
    expect(commentRunsFromText("hello  \n")).toEqual([{ text: "hello", marks: [] }]);
    expect(commentRunsFromText("  \n")).toEqual([]);
    expect(commentText(commentRunsFromText("a b"))).toBe("a b");
  });
  it("labels every dispatch status", () => {
    expect(spaceCommentDispatchLabel("cancelled")).toBe("Stopped");
  });
});

describe("groupSpaceCommentThreads", () => {
  it("groups open threads by their current block and sets detached ones apart", () => {
    const merged = thread("m", {
      anchorState: "merged",
      resolvedBlockId: SpaceBlockId.make("block-a"),
    });
    const grouped = groupSpaceCommentThreads([
      thread("a"),
      merged,
      detached("gone"),
      thread("done", { status: "resolved" }),
    ]);
    expect(grouped.openCount).toBe(3);
    expect(grouped.byBlock.get(SpaceBlockId.make("block-a"))?.map((t) => t.id)).toEqual(["a", "m"]);
    expect(grouped.detached.map((t) => t.id)).toEqual(["gone"]);
  });
});

describe("spaceCommentThreadChoices", () => {
  const shells = [
    shell("old", "2026-10-01T00:00:00.000Z"),
    shell("new", "2026-10-20T00:00:00.000Z"),
    shell("archived", "2026-10-25T00:00:00.000Z", { archivedAt: "2026-10-26T00:00:00.000Z" }),
    shell("elsewhere", "2026-10-30T00:00:00.000Z", { environmentId: EnvironmentId.make("other") }),
  ];
  it("lists recent sessions of the environment for an empty query", () => {
    const items = spaceCommentThreadChoices({ shells, environmentId, query: " ", now: 0 });
    expect(items.map((item) => item.thread.threadId)).toEqual(["new", "old"]);
  });
  it("matches a query without leaving the environment or archived sessions", () => {
    const items = spaceCommentThreadChoices({
      shells,
      environmentId,
      query: "thread",
      now: Date.parse("2026-11-01T00:00:00.000Z"),
    });
    expect(items.map((item) => item.thread.threadId).toSorted()).toEqual(["new", "old"]);
  });
});

describe("submitSpaceComment", () => {
  const saved = { commentId: SpaceCommentId.make("c1") };
  it("keeps the saved comment when the send fails", async () => {
    const failure = new Error("offline");
    const outcome = await submitSpaceComment({
      write: async () => saved,
      dispatch: async () => {
        throw failure;
      },
    });
    expect(outcome).toEqual({ result: saved, dispatchError: failure });
  });
  it("sends with the written comment id", async () => {
    const sent: string[] = [];
    const outcome = await submitSpaceComment({
      write: async () => saved,
      dispatch: async (result) => void sent.push(result.commentId),
    });
    expect(sent).toEqual(["c1"]);
    expect(outcome.dispatchError).toBeNull();
  });
});
