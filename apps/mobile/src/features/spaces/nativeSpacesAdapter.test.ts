import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { SpaceBlock } from "@t2code/contracts/spaces";
import { spaceDraftMaxBytes } from "@t2code/client-runtime/spaces";

import {
  applySpacesNativeSnapshot,
  nativeDocumentForSpaceBlock,
  receiveSpacesNativeSnapshot,
  SPACES_NATIVE_MAX_UTF16,
  SPACES_NATIVE_MAX_RUNS,
} from "./nativeSpacesAdapter";
import { decodeSpacesNativeSnapshot } from "./nativeSpacesProtocol";

const decodeBlock = Schema.decodeUnknownSync(SpaceBlock);

function block(content: unknown, extra: Record<string, unknown> = {}) {
  return decodeBlock({
    id: "block-1",
    parentId: null,
    order: "a",
    type: "paragraph",
    version: 1,
    content,
    ...extra,
  });
}

describe("Spaces native adapter public boundary", () => {
  it("round-trips combined marks, links, emoji and heading metadata through rich native runs", () => {
    const original = block(
      {
        level: 2,
        runs: [
          {
            text: "A😀",
            marks: [
              { type: "bold", version: 1 },
              { type: "italic", version: 1 },
              { type: "code", version: 1 },
              { type: "link", version: 1, href: "https://t2.codes" },
            ],
          },
          { text: " plain", marks: [] },
        ],
      },
      { type: "heading" },
    );
    const document = nativeDocumentForSpaceBlock(original);
    expect(document?.runs).toEqual([
      { text: "A😀", bold: true, italic: true, code: true, link: "https://t2.codes" },
      { text: " plain", bold: false, italic: false, code: false },
    ]);
    expect(
      applySpacesNativeSnapshot(original, {
        ...document,
        revision: 4,
        composing: false,
        typing: { bold: true, italic: true, code: true, link: "https://t2.codes" },
        selection: { start: 1, end: 3 },
      }),
    ).toEqual(original);
  });

  it.each([
    block({ runs: [{ text: "keep", marks: [{ type: "strike", version: 1 }] }] }),
    block({ runs: [{ text: "keep", marks: [{ type: "future", version: 2, opaque: [1] }] }] }),
    block({ runs: [{ text: "keep", marks: [{ type: "bold", version: 2 }] }] }),
    block({ runs: [{ text: "keep", marks: [], future: { retain: true } }] }),
    block({ runs: [{ text: "keep", marks: [] }], icon: "info" }, { type: "callout" }),
    block({ nested: [{ preserve: "verbatim" }] }, { type: "future", version: 3 }),
    block({
      runs: [
        {
          text: "keep",
          marks: [
            { type: "link", version: 1, href: "https://t2.codes" },
            { type: "link", version: 1, href: "https://example.com" },
          ],
        },
      ],
    }),
  ])("keeps unsupported content read-only and unchanged %#", (original) => {
    const before = JSON.stringify(original);
    expect(nativeDocumentForSpaceBlock(original)).toBeNull();
    expect(() => applySpacesNativeSnapshot(original, {})).toThrow("read-only");
    expect(JSON.stringify(original)).toBe(before);
  });

  it("accepts a native text replacement with exact mark boundaries and keeps to-do metadata", () => {
    const original = block(
      { checked: true, runs: [{ text: "old", marks: [] }] },
      { type: "todo_item" },
    );
    const result = applySpacesNativeSnapshot(original, {
      version: 1,
      revision: 2,
      composing: false,
      typing: { bold: false, italic: true, code: true },
      selection: { start: 3, end: 3 },
      runs: [
        { text: "😀", bold: true, italic: false, code: false },
        { text: "x", bold: false, italic: true, code: true },
      ],
    });
    expect(result).toEqual({
      ...original,
      content: {
        checked: true,
        runs: [
          { text: "😀", marks: [{ type: "bold", version: 1 }] },
          {
            text: "x",
            marks: [
              { type: "italic", version: 1 },
              { type: "code", version: 1 },
            ],
          },
        ],
      },
    });
  });

  it("rejects malformed, composing, unsafe-link and over-budget native writes", () => {
    const original = block({ runs: [{ text: "safe", marks: [] }] });
    const snapshot = {
      ...nativeDocumentForSpaceBlock(original),
      revision: 1,
      composing: false,
      typing: { bold: false, italic: false, code: false },
    };
    expect(() => applySpacesNativeSnapshot(original, { ...snapshot, version: 2 })).toThrow();
    expect(() => applySpacesNativeSnapshot(original, { ...snapshot, composing: true })).toThrow(
      "composition",
    );
    expect(() =>
      applySpacesNativeSnapshot(original, {
        ...snapshot,
        runs: [
          { text: "unsafe", bold: false, italic: false, code: false, link: "javascript:alert(1)" },
        ],
      }),
    ).toThrow("link");
    const maximum = {
      ...snapshot,
      runs: [
        { text: "x".repeat(SPACES_NATIVE_MAX_UTF16), bold: false, italic: false, code: false },
      ],
    };
    expect(applySpacesNativeSnapshot(original, maximum).content).toEqual({
      runs: [{ text: "x".repeat(SPACES_NATIVE_MAX_UTF16), marks: [] }],
    });
    expect(() =>
      applySpacesNativeSnapshot(original, {
        ...maximum,
        runs: [{ ...maximum.runs[0], text: "x".repeat(SPACES_NATIVE_MAX_UTF16 + 1) }],
      }),
    ).toThrow("budget");
  });

  it("rejects UTF-16 selections inside emoji and ignores out-of-order native events", () => {
    const latest = decodeSpacesNativeSnapshot({
      version: 1,
      revision: 5,
      composing: false,
      typing: { bold: false, italic: false, code: false },
      runs: [{ text: "😀x", bold: false, italic: false, code: false }],
      selection: { start: 2, end: 3 },
    });
    expect(receiveSpacesNativeSnapshot(latest, { ...latest, revision: 4, composing: true })).toBe(
      latest,
    );
    expect(() =>
      decodeSpacesNativeSnapshot({ ...latest, selection: { start: 1, end: 2 } }),
    ).toThrow("UTF-16");
    expect(() =>
      decodeSpacesNativeSnapshot({ ...latest, selection: { start: 0, end: 4 } }),
    ).toThrow("UTF-16");
    expect(() =>
      decodeSpacesNativeSnapshot({ ...latest, selection: { start: 3, end: 2 } }),
    ).toThrow("UTF-16");
  });

  it("leaves source blocks above either native budget read-only and bounds native run output", () => {
    const runs = Array.from({ length: SPACES_NATIVE_MAX_RUNS }, (_, index) => ({
      text: "x",
      marks: index % 2 ? [{ type: "bold", version: 1 }] : [],
    }));
    const original = block({ runs });
    const document = nativeDocumentForSpaceBlock(original);
    expect(document?.runs).toHaveLength(SPACES_NATIVE_MAX_RUNS);
    const snapshot = {
      ...document,
      composing: false,
      typing: { bold: false, italic: false, code: false },
    };
    expect(applySpacesNativeSnapshot(original, snapshot)).toEqual(original);
    expect(
      nativeDocumentForSpaceBlock(block({ runs: [...runs, { text: "extra", marks: [] }] })),
    ).toBeNull();
    expect(() =>
      applySpacesNativeSnapshot(original, {
        ...snapshot,
        runs: [...document!.runs, { text: "extra", bold: false, italic: false, code: false }],
      }),
    ).toThrow("budget");
    expect(
      nativeDocumentForSpaceBlock(
        block({ runs: [{ text: "x".repeat(SPACES_NATIVE_MAX_UTF16), marks: [] }] }),
      ),
    ).not.toBeNull();
    expect(
      nativeDocumentForSpaceBlock(
        block({ runs: [{ text: "x".repeat(SPACES_NATIVE_MAX_UTF16 + 1), marks: [] }] }),
      ),
    ).toBeNull();
  });

  it("rejects unpublishable events before advancing the admitted snapshot, including composition", () => {
    const original = block({
      runs: Array.from({ length: SPACES_NATIVE_MAX_RUNS }, (_, index) => ({
        text: "abc",
        marks: index % 2 ? [{ type: "bold", version: 1 }] : [],
      })),
    });
    const previous = decodeSpacesNativeSnapshot({
      ...nativeDocumentForSpaceBlock(original),
      composing: false,
      typing: { bold: false, italic: false, code: false },
    });
    const first = previous.runs[0]!;
    const split = [
      { ...first, text: "a" },
      { ...first, text: "b", italic: true },
      { ...first, text: "c" },
      ...previous.runs.slice(1),
    ];
    for (const composing of [false, true]) {
      for (const runs of [
        split,
        [{ ...first, text: "x".repeat(SPACES_NATIVE_MAX_UTF16 + 1) }],
        [{ ...first, link: "javascript:alert(1)" }],
        [{ ...first, text: "x", link: `https://t2.codes/${"a".repeat(spaceDraftMaxBytes)}` }],
      ]) {
        expect(() =>
          receiveSpacesNativeSnapshot(previous, { ...previous, revision: 1, composing, runs }),
        ).toThrow();
      }
    }
    expect(applySpacesNativeSnapshot(original, previous)).toEqual(original);
    expect(
      nativeDocumentForSpaceBlock(
        block({
          runs: [
            {
              text: "x",
              marks: [
                {
                  type: "link",
                  version: 1,
                  href: `https://t2.codes/${"a".repeat(spaceDraftMaxBytes)}`,
                },
              ],
            },
          ],
        }),
      ),
    ).toBeNull();
    const recovered = receiveSpacesNativeSnapshot(previous, { ...previous, revision: 2 });
    expect(recovered.revision).toBe(2);
    expect(applySpacesNativeSnapshot(original, recovered)).toEqual(original);
  });
});
