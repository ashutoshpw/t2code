import type { SpaceRichRun } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { retainMarks } from "./richText.ts";

const run = (text: string, ...types: string[]) =>
  ({ text, marks: types.map((type) => ({ type, version: 1 })) }) as unknown as SpaceRichRun;
const text = (runs: ReadonlyArray<SpaceRichRun>) => runs.map((entry) => entry.text).join("");

describe("retainMarks", () => {
  const spans = [run("plain "), run("bold", "bold"), run(" tail", "italic")];

  it("returns the same runs for unchanged text", () => {
    expect(retainMarks(spans, "plain bold tail")).toBe(spans);
  });

  it("keeps marks in the unchanged prefix and suffix", () => {
    const next = retainMarks(spans, "plain bold tail!!");
    expect(next.map((entry) => entry.text)).toEqual(["plain ", "bold", " tail", "!!"]);
    expect(next[2]?.marks).toEqual(spans[2]?.marks);
    expect(next[3]?.marks).toEqual([]);
  });

  it("gives the replaced middle the marks of the run where the change starts", () => {
    const next = retainMarks(spans, "plain BOLDER tail");
    expect(next.map((entry) => entry.text)).toEqual(["plain ", "BOLDER", " tail"]);
    expect(next[1]?.marks).toEqual(spans[1]?.marks);
  });

  it("takes no marks for text added past the end, and merges neighbours with equal marks", () => {
    const next = retainMarks([run("a", "bold")], "ab");
    expect(next).toEqual([run("a", "bold"), run("b")]);
    expect(retainMarks([run("ab"), run("cd")], "abXcd").map((entry) => entry.text)).toEqual([
      "abXcd",
    ]);
  });

  it("drops marks along with deleted text and leaves a link's other runs alone", () => {
    const linked = [
      run("see "),
      { ...run("docs", "link"), marks: [{ type: "link", version: 1, href: "x" }] },
    ];
    const next = retainMarks(linked as unknown as SpaceRichRun[], "see ");
    expect(next.map((entry) => entry.text)).toEqual(["see "]);
    expect(text(retainMarks(linked as unknown as SpaceRichRun[], "see all docs"))).toBe(
      "see all docs",
    );
  });
});
