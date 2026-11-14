import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { SpaceCommentAnchor, SpaceCommentAuthor, SpaceCommentsListInput } from "./spaces.ts";

const decodes = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(value)._tag === "Success";

describe("space comment contracts", () => {
  it("accepts a range anchor only when its offsets span the quote", () => {
    const range = { kind: "range", quote: "abc", prefix: "", suffix: "", start: 2, end: 5 };
    expect(decodes(SpaceCommentAnchor, { kind: "block" })).toBe(true);
    expect(decodes(SpaceCommentAnchor, range)).toBe(true);
    expect(decodes(SpaceCommentAnchor, { ...range, end: 6 })).toBe(false);
  });

  it("decodes both list forms and requires a thread id for agent authors", () => {
    expect(
      decodes(SpaceCommentsListInput, { environmentId: "e", pageId: "p", status: "open" }),
    ).toBe(true);
    expect(decodes(SpaceCommentsListInput, { environmentId: "e", commentThreadId: "t" })).toBe(
      true,
    );
    expect(decodes(SpaceCommentAuthor, { kind: "agent" })).toBe(false);
    expect(decodes(SpaceCommentAuthor, { kind: "agent", threadId: "thread-1" })).toBe(true);
  });
});
