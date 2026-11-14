import { EnvironmentId } from "@t2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { dataSource, property, view } from "./databaseFixtures.test-support";
import { feedQueryInput, previewLines } from "./feedItems";

const source = dataSource([property("title", "Name", "title"), property("note", "Note", "text")]);
const opts = { environmentId: EnvironmentId.make("env1"), timeZone: "UTC", maxQueryRows: 500 };
const run = (text: string) => ({ text, marks: [] });

describe("feedQueryInput", () => {
  it("asks for rows with the chosen preview and a bounded window", () => {
    const input = feedQueryInput(view("feed", { layout: { previewBlocks: 5 } }), source, opts);
    expect(input).toMatchObject({ mode: "rows", limit: 25, include: { preview: 5 } });
  });

  it("sends no preview when it is off", () => {
    const input = feedQueryInput(view("feed", { layout: { previewBlocks: 0 } }), source, opts);
    expect(input.include).toBeUndefined();
  });
});

describe("previewLines", () => {
  it("joins runs, marks todos, labels textless blocks and skips dividers", () => {
    expect(
      previewLines({
        more: false,
        blocks: [
          { type: "heading", level: 1, runs: [run("Hello "), run("world")] },
          { type: "todo_item", checked: true, runs: [run("Ship")] },
          { type: "image", runs: [] },
          { type: "divider", runs: [] },
        ],
      }),
    ).toEqual(["Hello world", "☑ Ship", "Image"]);
  });

  it("is empty without a preview", () => {
    expect(previewLines(undefined)).toEqual([]);
    expect(previewLines({ blocks: [], more: false })).toEqual([]);
  });
});
