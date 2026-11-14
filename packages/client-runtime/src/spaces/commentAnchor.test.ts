import type { SpaceCommentAnchor } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { anchorSpaceComment, captureSpaceCommentRange } from "./commentAnchor.ts";

const range = (text: string, start: number, end: number) => {
  const anchor = captureSpaceCommentRange(text, start, end);
  if (anchor === null) throw new Error("expected an anchor");
  return anchor;
};

describe("anchorSpaceComment", () => {
  const original = "the quick brown fox jumps over the lazy dog";
  const quick = range(original, 4, 9);
  const rows: ReadonlyArray<
    readonly [string, string, SpaceCommentAnchor, ReturnType<typeof anchorSpaceComment>]
  > = [
    ["unchanged", original, quick, { kind: "range", start: 4, end: 9 }],
    ["text inserted before", `Look: ${original}`, quick, { kind: "range", start: 10, end: 15 }],
    ["quote edited away", "the slow brown fox", quick, { kind: "block" }],
    ["empty text", "", quick, { kind: "block" }],
    ["block anchors stay on the block", original, { kind: "block" }, { kind: "block" }],
  ];
  it.each(rows)("%s", (_name, text, anchor, expected) => {
    expect(anchorSpaceComment(text, anchor)).toEqual(expected);
  });

  it("decides between duplicate quotes by prefix, then suffix, then proximity", () => {
    const dogSat = range("cat sat. dog sat.", 13, 16);
    expect(anchorSpaceComment("cat sat. cow sat. dog sat.", dogSat)).toEqual({
      kind: "range",
      start: 22,
      end: 25,
    });
    const first = range("sat in a hat. sat in a car", 0, 3);
    expect(anchorSpaceComment("hmm sat in a hat. sat in a car", first)).toEqual({
      kind: "range",
      start: 4,
      end: 7,
    });
    const stale: SpaceCommentAnchor = {
      kind: "range",
      quote: "X",
      prefix: "",
      suffix: "",
      start: 3,
      end: 4,
    };
    expect(anchorSpaceComment("XaXaX", stale)).toEqual({ kind: "range", start: 2, end: 3 });
  });
});

describe("captureSpaceCommentRange", () => {
  it("clamps the quote and its context, and refuses an empty selection", () => {
    const text = `${"a".repeat(40)}${"q".repeat(2000)}${"z".repeat(40)}`;
    const anchor = range(text, 40, 2040);
    expect(anchor.quote).toHaveLength(1024);
    expect(anchor.end - anchor.start).toBe(1024);
    expect(anchor.prefix).toBe("a".repeat(32));
    expect(anchor.suffix).toBe("q".repeat(32));
    expect(captureSpaceCommentRange("abc", 2, 2)).toBeNull();
    expect(captureSpaceCommentRange("abc", 2, 1)).toBeNull();
  });
});
