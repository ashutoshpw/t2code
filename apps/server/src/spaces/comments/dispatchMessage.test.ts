import { describe, expect, it } from "@effect/vitest";
import { commentDispatchMessage } from "./dispatchMessage.ts";

const base = {
  pageTitle: "Roadmap",
  environmentId: "env_1",
  pageId: "page_1",
  blockId: "block_1",
  commentThreadId: "thread_1",
  commentId: "comment_1",
  text: "Fix the typo",
};
const ids =
  "environmentId: env_1 · pageId: page_1 · blockId: block_1 · commentThreadId: thread_1 · commentId: comment_1";

describe("commentDispatchMessage", () => {
  it.each([
    {
      name: "edit with a quote",
      input: { ...base, mode: "edit" as const, quote: "teh" },
      expected: `A comment on the Spaces page "Roadmap" was sent to you.\n\nFix the typo\n\nChange the page as the comment asks, using the Spaces tools. Then reply in the comment thread with t2_spaces_comments (action "reply") saying what you changed. Do not resolve the comment; the user does.\n\nQuoted text: "teh"\n${ids}`,
    },
    {
      name: "message without a quote",
      input: { ...base, mode: "message" as const },
      expected: `A comment on the Spaces page "Roadmap" was sent to you.\n\nFix the typo\n\nReply in the comment thread with t2_spaces_comments (action "reply").\n${ids}`,
    },
  ])("renders $name", ({ input, expected }) => {
    expect(commentDispatchMessage(input)).toBe(expected);
  });
});
