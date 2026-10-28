import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { SpaceBlock } from "./spaces.ts";

const decode = Schema.decodeUnknownSync(SpaceBlock);
const encode = Schema.encodeSync(SpaceBlock);

describe("Spaces value preservation", () => {
  it.each([
    {
      id: "opaque",
      parentId: null,
      order: "a",
      type: "future-table",
      version: 7,
      content: { cells: [{ formula: "sum", refs: ["block-2"] }] },
      futureEnvelope: { enabled: true },
    },
    {
      id: "paragraph",
      parentId: "list",
      order: "b",
      type: "paragraph",
      version: 2,
      content: { futureRuns: [1, 2] },
    },
    {
      id: "marks",
      parentId: null,
      order: "c",
      type: "paragraph",
      version: 1,
      content: {
        runs: [
          {
            text: "keep",
            marks: [
              { type: "link", version: 1, href: "javascript:alert(1)" },
              { type: "future-mark", version: 4, opaque: { target: "block-2" } },
            ],
          },
        ],
      },
    },
  ])("round-trips opaque payloads without interpreting or stripping them ($id)", (raw) => {
    expect(encode(decode(raw))).toEqual(raw);
  });

  it("rejects a missing stable identity and non-JSON content", () => {
    expect(() =>
      decode({ parentId: null, order: "a", type: "paragraph", version: 1, content: {} }),
    ).toThrow();
    expect(() =>
      decode({
        id: "b",
        parentId: null,
        order: "a",
        type: "future",
        version: 1,
        content: { fn: () => 1 },
      }),
    ).toThrow();
  });
});
