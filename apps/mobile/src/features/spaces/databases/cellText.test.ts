import { knownProperty } from "@t2code/client-runtime/spaces";
import { describe, expect, it } from "vite-plus/test";

import { cardLine, cardLines, rowDisplayTitle, type LineColumn } from "./cellText";
import { property, row } from "./databaseFixtures.test-support";

const options = [
  { id: "todo1", name: "Todo", color: "red", group: "todo" },
  { id: "done1", name: "Done", color: "green", group: "complete" },
];
const tagOptions = options.map(({ group: _group, ...rest }) => rest);
const column = (
  id: string,
  type: string,
  config: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): LineColumn => {
  const prop = property(id, id, type, config as never, extra as never);
  return { property: prop, known: knownProperty(prop) };
};
const context = {
  relatedPages: {
    p1: { title: "Alpha", dataSourceId: "other" },
    p2: { title: "", dataSourceId: "other" },
  },
  optionHint: () => undefined,
  timeZone: "UTC",
} as never;
const line = (col: LineColumn, value: unknown) =>
  cardLine(row("r", "Row", { [col.property.id]: value as never }), col, context);

describe("cardLine", () => {
  it("formats plain values", () => {
    expect(line(column("n", "number", { format: "dollar", decimals: 2 }), 12)?.text).toBe("$12.00");
    expect(line(column("u", "url"), "https://t2.codes")?.text).toBe("https://t2.codes");
    expect(
      line(column("t", "text"), [
        { text: "Hello ", marks: [] },
        { text: "there", marks: [] },
      ])?.text,
    ).toBe("Hello there");
    expect(line(column("d", "date", { dateFormat: "ymd" }), { start: "2026-11-11" })?.text).toBe(
      "2026/11/11",
    );
    expect(line(column("c", "created_time", {}), "2026-11-11T10:00:00Z")?.text).toContain(
      "November 11, 2026",
    );
    expect(line(column("i", "unique_id", {}), { number: 7, prefix: "T" })?.text).toBe("T-7");
    expect(line(column("f", "files", {}), [{ name: "a.png", url: "https://x" }])?.text).toBe(
      "a.png",
    );
  });

  it("returns chips for select, status and multi-select, skipping options that no longer exist", () => {
    expect(line(column("s", "status", { options }), "todo1")?.chips).toEqual([
      { id: "todo1", name: "Todo", color: "red" },
    ]);
    expect(
      line(column("m", "multi_select", { options: tagOptions }), ["todo1", "gone", "done1"])?.chips,
    ).toEqual([
      { id: "todo1", name: "Todo", color: "red" },
      { id: "done1", name: "Done", color: "green" },
    ]);
    expect(line(column("s", "select", { options: tagOptions }), "gone")).toBeNull();
  });

  it("shows a checkbox either way and relations with their titles", () => {
    expect(line(column("k", "checkbox"), true)).toMatchObject({ checked: true, text: "" });
    expect(line(column("k", "checkbox"), undefined)).toMatchObject({ checked: false });
    expect(
      line(column("r", "relation", { dataSourceId: "other", limit: "many" }), ["p1", "p2", "p3"]),
    ).toMatchObject({
      text: "Alpha, Untitled, Untitled",
      related: [
        { pageId: "p1", title: "Alpha", dataSourceId: "other" },
        { pageId: "p2", title: "Untitled", dataSourceId: "other" },
        { pageId: "p3", title: "Untitled", dataSourceId: undefined },
      ],
    });
  });

  it("leaves empty values out", () => {
    for (const [type, config, empty] of [
      ["text", {}, []],
      ["number", { format: "number" }, undefined],
      ["url", {}, ""],
      ["date", {}, null],
      ["multi_select", { options: [] }, []],
    ] as const)
      expect(line(column("e", type, config), empty)).toBeNull();
  });

  it("reads formula and rollup values from the computed envelope", () => {
    const info = { resultType: "number" };
    const formula = column("f", "formula", { expression: "1" }, { computed: info });
    expect(line(formula, { type: "number", value: 4 })?.text).toBe("4");
    expect(line(formula, { type: "string", value: "hi" })?.text).toBe("hi");
    expect(
      line(column("g", "formula", { expression: "1" }, { computed: { resultType: "boolean" } }), {
        type: "boolean",
        value: true,
      })?.text,
    ).toBe("Checked");
    expect(line(formula, { type: "date", value: { start: "2026-11-11" } })?.text).toBe(
      "November 11, 2026",
    );
    expect(line(formula, { type: "page", value: "p1" })?.text).toBe("Alpha");
    expect(
      line(formula, {
        type: "array",
        value: [
          { type: "string", value: "a" },
          { type: "string", value: "b" },
        ],
        truncated: true,
      })?.text,
    ).toBe("a, b, …");
    const rollup = column(
      "r",
      "rollup",
      {
        relationPropertyId: "rel01",
        targetPropertyId: "tgt01",
        function: "sum",
        format: "percent",
      },
      { computed: { resultType: "number" } },
    );
    expect(line(rollup, { type: "number", value: 0.5 })?.text).toBe("50%");
  });

  it("shows Error for a computed property in error, nothing before it is compiled, and Unsupported for a future value", () => {
    const failed = column(
      "f",
      "formula",
      { expression: "1" },
      { computed: { resultType: "number", error: { message: "bad" } } },
    );
    expect(line(failed, undefined)).toMatchObject({ text: "Error", error: true });
    const compiled = column(
      "c",
      "formula",
      { expression: "1" },
      { computed: { resultType: "number" } },
    );
    expect(line(compiled, undefined)).toBeNull();
    expect(line(compiled, { type: "hologram", value: 1 })).toMatchObject({
      text: "Unsupported",
      unsupported: true,
    });
  });

  it("shows Unsupported for a property type it does not know", () => {
    const future = column("x", "hologram");
    expect(future.known).toBeNull();
    expect(line(future, "whatever")).toMatchObject({ text: "Unsupported", unsupported: true });
    expect(line(future, undefined)).toMatchObject({ text: "Unsupported" });
  });
});

describe("cardLines", () => {
  it("keeps column order and skips empty cells", () => {
    const columns = [column("a", "number"), column("b", "url"), column("c", "number")];
    const lines = cardLines(row("r", "Row", { c: 3, a: 1 }), columns, context);
    expect(lines.map((entry) => entry.propertyId)).toEqual(["a", "c"]);
  });

  it("titles a row from its title cell, then the page title, then Untitled", () => {
    expect(rowDisplayTitle(row("r", "Cell"))).toBe("Cell");
    const blank = row("r", "");
    expect(rowDisplayTitle({ ...blank, page: { ...blank.page, title: "Page" } })).toBe("Page");
    expect(rowDisplayTitle(row("r", ""))).toBe("Untitled");
  });
});
