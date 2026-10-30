import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceBlockId,
  SpacePageId,
  type SpaceBlock,
  type SpaceMark,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import {
  canEditSpaceBlockOnMobile,
  copySpaceBlocks,
  editSpaceMobileText,
  isSpaceListItem,
  joinSpaceTextBlocks,
  spaceBlockRuns,
  splitSpaceTextBlock,
} from "./index.ts";

const key = {
  environmentId: EnvironmentId.make("environment-1"),
  pageId: SpacePageId.make("page-1"),
};
function paragraph(text: string, marks: readonly SpaceMark[] = []): SpaceBlock {
  return {
    id: SpaceBlockId.make("a"),
    parentId: null,
    order: "a",
    type: "paragraph",
    version: 1,
    content: { runs: [{ text, marks }] },
  };
}

describe("shared Spaces editing", () => {
  it("edits UTF-16 ranges across styled runs while preserving links and untouched marks", () => {
    const block = {
      ...paragraph(""),
      content: {
        runs: [
          { text: "A😀", marks: [{ type: "bold", version: 1 }] },
          { text: "linked", marks: [{ type: "link", version: 1, href: "https://example.com" }] },
          {
            text: " end",
            marks: [
              { type: "italic", version: 1 },
              { type: "code", version: 1 },
            ],
          },
        ],
      },
    };
    const edited = editSpaceMobileText(block, { start: 3, end: 9, text: "new" });
    expect(spaceBlockRuns(edited)).toEqual([
      { text: "A😀", marks: [{ type: "bold", version: 1 }] },
      { text: "new", marks: [{ type: "link", version: 1, href: "https://example.com" }] },
      {
        text: " end",
        marks: [
          { type: "italic", version: 1 },
          { type: "code", version: 1 },
        ],
      },
    ]);
    expect(edited.id).toBe(block.id);
    expect(() => editSpaceMobileText(block, { start: 2, end: 3, text: "x" })).toThrow("UTF-16");
  });

  it("nests under toggles but keeps them read-only on mobile", () => {
    const toggle = { ...paragraph("summary"), type: "toggle" };
    expect(isSpaceListItem(toggle)).toBe(true);
    expect(canEditSpaceBlockOnMobile(toggle)).toBe(false);
    expect(spaceBlockRuns(toggle)).toEqual([{ text: "summary", marks: [] }]);
  });

  it.each([
    { marks: [] },
    {
      marks: [
        { type: "bold", version: 1 },
        { type: "italic", version: 1 },
        { type: "code", version: 1 },
        { type: "link", version: 1, href: "https://example.com/first" },
      ],
    },
  ] satisfies readonly { readonly marks: readonly SpaceMark[] }[])(
    "bounds rich-run payloads through repeated typing (marks: $marks)",
    ({ marks }) => {
      const boundaries = [
        { text: "bold", marks: [{ type: "bold", version: 1 }] },
        {
          text: "first link",
          marks: [{ type: "link", version: 1, href: "https://example.com/first" }],
        },
        {
          text: "second link",
          marks: [{ type: "link", version: 1, href: "https://example.com/second" }],
        },
      ];
      let block: SpaceBlock = {
        ...paragraph(""),
        content: { runs: [{ text: "a", marks }, ...boundaries] },
      };
      for (let offset = 1; offset <= 200; offset++) {
        block = editSpaceMobileText(block, {
          start: offset,
          end: offset,
          text: "x",
          marks: offset % 2 === 0 ? marks.toReversed() : marks,
        });
      }
      expect(spaceBlockRuns(block)).toEqual([
        { text: `a${"x".repeat(200)}`, marks },
        ...boundaries,
      ]);
      expect(JSON.stringify(block).length).toBeLessThan(1000);
    },
  );

  it.each([
    { mark: { type: "strike", version: 1 } },
    {
      mark: {
        type: "block_mention",
        version: 1,
        target: { ...key, blockId: SpaceBlockId.make("other") },
      },
    },
    { mark: { type: "link", version: 1, href: "javascript:alert(1)" } },
    { mark: { type: "link", version: 2, href: "https://example.com" } },
    { mark: { type: "future", version: 1, data: { keep: true } } },
  ] satisfies readonly { readonly mark: SpaceMark }[])(
    "keeps unsupported marks read-only on mobile ($mark.type)",
    ({ mark }) => {
      const block = paragraph("preserve", [mark]);
      expect(canEditSpaceBlockOnMobile(block)).toBe(false);
      expect(() => editSpaceMobileText(block, { start: 0, end: 1, text: "x" })).toThrow(
        "read-only",
      );
      expect(spaceBlockRuns(block)).toEqual([{ text: "preserve", marks: [mark] }]);
    },
  );

  it("keeps the first identity through split and join and produces an explicit merge tombstone", () => {
    const original = paragraph("hello world", [{ type: "bold", version: 1 }]);
    const [first, second] = splitSpaceTextBlock(original, 5, {
      id: SpaceBlockId.make("b"),
      order: "b",
    });
    expect(first.id).toBe(original.id);
    expect(second.id).toBe("b");
    expect(spaceBlockRuns(first)).toEqual([
      { text: "hello", marks: [{ type: "bold", version: 1 }] },
    ]);
    expect(spaceBlockRuns(second)).toEqual([
      { text: " world", marks: [{ type: "bold", version: 1 }] },
    ]);
    const joined = joinSpaceTextBlocks(first, second);
    expect(joined.block.id).toBe(original.id);
    expect(joined.tombstone).toEqual({ blockId: "b", mergedInto: "a" });
    expect(
      spaceBlockRuns(joined.block)
        ?.map((run) => run.text)
        .join(""),
    ).toBe("hello world");
  });

  it("starts a paragraph when a heading is split at its end", () => {
    const heading = {
      ...paragraph("Title"),
      type: "heading",
      content: { level: 2, runs: [{ text: "Title", marks: [] }] },
    } as never;
    const [first, second] = splitSpaceTextBlock(heading, 5, {
      id: SpaceBlockId.make("b"),
      order: "b",
    });
    expect(first).toBe(heading);
    expect(second).toMatchObject({ id: "b", type: "paragraph", content: { runs: [] } });
  });

  it("copies fresh subtree identities and remaps only internal mentions in the same page", () => {
    const parent = { ...paragraph("parent"), type: "bulleted_item" };
    const child = {
      ...paragraph(""),
      id: SpaceBlockId.make("b"),
      parentId: parent.id,
      content: {
        runs: [
          {
            text: "ref",
            marks: [
              { type: "block_mention", version: 1, target: { ...key, blockId: parent.id } },
              {
                type: "block_mention",
                version: 1,
                target: { ...key, pageId: SpacePageId.make("other-page"), blockId: parent.id },
              },
            ],
          },
        ],
      },
    };
    let id = 0;
    const copied = copySpaceBlocks([parent, child], key, () => SpaceBlockId.make(`copy-${++id}`));
    expect(copied.map((block) => [block.id, block.parentId])).toEqual([
      ["copy-1", null],
      ["copy-2", "copy-1"],
    ]);
    expect(spaceBlockRuns(copied[1]!)?.[0]?.marks).toEqual([
      { type: "block_mention", version: 1, target: { ...key, blockId: "copy-1" } },
      { type: "block_mention", version: 1, target: { ...key, pageId: "other-page", blockId: "a" } },
    ]);
  });

  it.each([
    { ...paragraph(""), type: "child_page", content: { pageId: "nested" } },
    { ...paragraph(""), type: "future", content: { opaqueRef: "a" } },
    paragraph("unknown", [{ type: "future", version: 1, blockId: "a" }]),
  ])(
    "refuses to pretend copying can duplicate unknown references or nested page ownership ($type)",
    (block) => {
      expect(() => copySpaceBlocks([block], key, () => SpaceBlockId.make("copy"))).toThrow();
    },
  );
});
