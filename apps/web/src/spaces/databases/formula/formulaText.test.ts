import { describe, expect, it } from "vite-plus/test";

import { mapServerDetail, positionOf, segmentsOf } from "./formulaText";

describe("formula text helpers", () => {
  it("reports 1-based line and column", () => {
    expect(positionOf("ab\ncd", 0)).toEqual({ line: 1, column: 1 });
    expect(positionOf("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
  });

  it("splits the source at diagnostic spans and clamps them", () => {
    expect(segmentsOf("1 + foo", [{ start: 4, end: 99, message: "x" }])).toEqual([
      { text: "1 + " },
      { text: "foo", message: "x" },
    ]);
    expect(segmentsOf("abc", [])).toEqual([{ text: "abc" }]);
    expect(
      segmentsOf("abcdef", [
        { start: 1, end: 4, message: "first" },
        { start: 2, end: 5, message: "second" },
      ]),
    ).toEqual([
      { text: "a" },
      { text: "bcd", message: "first" },
      { text: "e", message: "second" },
      { text: "f" },
    ]);
  });

  it("maps the server's line:column refusal back to a span", () => {
    const source = '1 +\nprop("Nope") * 2';
    expect(mapServerDetail('2:6 There is no property named "Nope".', source)).toEqual({
      start: 9,
      end: 15,
      message: 'There is no property named "Nope".',
    });
    expect(mapServerDetail("not a position", source)).toBeNull();
    expect(mapServerDetail("9:1 gone", source)).toBeNull();
  });
});
