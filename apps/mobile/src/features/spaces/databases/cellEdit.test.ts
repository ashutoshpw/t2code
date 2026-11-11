import { describe, expect, it } from "vite-plus/test";

import {
  commitCheckbox,
  commitValue,
  DATE_ERROR,
  DATE_START_ERROR,
  DESKTOP_ONLY_NOTE,
  detectDecimalSeparator,
  editorFor,
  FORMATTED_TEXT_NOTE,
  NUMBER_ERROR,
  TIMED_DATE_NOTE,
  UNSUPPORTED_NOTE,
} from "./cellEdit";
import { dataSource, property, view } from "./databaseFixtures.test-support";
import { newRowInput } from "./addRow";

const options = [
  { id: "a", name: "Alpha", color: "blue" },
  { id: "b", name: "Beta", color: "red" },
];

describe("editorFor", () => {
  it.each([
    ["title", "Hello", "Hello"],
    ["url", "https://a.test", "https://a.test"],
    ["email", "a@b.test", "a@b.test"],
    ["phone", "+1 555", "+1 555"],
  ])("edits a %s as one line of text", (type, value, initial) => {
    expect(editorFor(property("p", "P", type), value)).toEqual({
      kind: "text",
      field: type,
      initial,
      multiline: false,
      format: "",
    });
  });

  it("starts an empty text property blank and joins unmarked runs", () => {
    const text = property("p", "Notes", "text");
    expect(editorFor(text, undefined)).toMatchObject({
      field: "text",
      initial: "",
      multiline: true,
    });
    expect(
      editorFor(text, [
        { text: "one ", marks: [] },
        { text: "two", marks: [] },
      ]),
    ).toMatchObject({ initial: "one two" });
  });

  it("leaves text with marks, or of an unknown shape, to the desktop", () => {
    const text = property("p", "Notes", "text");
    expect(editorFor(text, [{ text: "bold", marks: [{ type: "bold" }] }])).toEqual({
      kind: "readonly",
      note: FORMATTED_TEXT_NOTE,
    });
    expect(editorFor(text, "plain")).toMatchObject({ kind: "readonly", note: FORMATTED_TEXT_NOTE });
    expect(editorFor(text, [{ nope: 1 }])).toMatchObject({ kind: "readonly" });
  });

  it("shows a percent number as whole percents and keeps its format for parsing", () => {
    const number = property("p", "Rate", "number", { format: "percent" });
    expect(editorFor(number, 0.25)).toMatchObject({
      field: "number",
      initial: "25",
      format: "percent",
    });
  });

  it("offers a checkbox its current state and a select its options", () => {
    expect(editorFor(property("p", "Done", "checkbox"), true)).toEqual({
      kind: "checkbox",
      checked: true,
    });
    expect(editorFor(property("p", "Done", "checkbox"), undefined)).toMatchObject({
      checked: false,
    });
    expect(editorFor(property("p", "Kind", "select", { options }), "b")).toMatchObject({
      kind: "choice",
      multiple: false,
      selected: ["b"],
    });
    expect(editorFor(property("p", "Tags", "multi_select", { options }), ["a", "b"])).toMatchObject(
      {
        multiple: true,
        selected: ["a", "b"],
      },
    );
    expect(
      editorFor(
        property("p", "State", "status", {
          options: options.map((o) => ({ ...o, group: "todo" })),
        }),
        "a",
      ),
    ).toMatchObject({ kind: "choice", selected: ["a"] });
  });

  it("edits a day-only date and falls back to read-only for a time or a zone", () => {
    const date = property("p", "Due", "date");
    expect(editorFor(date, { start: "2026-11-05", end: "2026-11-07" })).toEqual({
      kind: "date",
      start: "2026-11-05",
      end: "2026-11-07",
    });
    expect(editorFor(date, undefined)).toEqual({ kind: "date", start: "", end: "" });
    const timed: ReadonlyArray<Record<string, string>> = [
      { start: "2026-11-05T09:00:00", timeZone: "UTC" },
      { start: "2026-11-05T09:00:00" },
      { start: "2026-11-05", timeZone: "UTC" },
      { start: "2026-11-05", end: "2026-11-06T10:00:00" },
    ];
    for (const value of timed)
      expect(editorFor(date, value)).toEqual({ kind: "readonly", note: TIMED_DATE_NOTE });
  });

  it("never edits relations, files, computed or unknown properties", () => {
    expect(
      editorFor(property("p", "R", "relation", { dataSourceId: "d", limit: "many" }), ["x"]),
    ).toEqual({
      kind: "readonly",
      note: DESKTOP_ONLY_NOTE,
    });
    expect(editorFor(property("p", "F", "files"), [])).toMatchObject({ note: DESKTOP_ONLY_NOTE });
    for (const type of ["created_time", "last_edited_time", "unique_id"])
      expect(editorFor(property("p", "X", type), undefined)).toEqual({
        kind: "readonly",
        note: null,
      });
    expect(editorFor(property("p", "U", "hologram"), undefined)).toEqual({
      kind: "readonly",
      note: UNSUPPORTED_NOTE,
    });
  });
});

describe("commitValue", () => {
  const text = (type: string, input: string, config = {}, separator = ".") => {
    const editor = editorFor(property("p", "P", type, config), undefined);
    return commitValue(editor, { kind: "text", text: input }, separator);
  };

  it("trims text and clears it when empty", () => {
    expect(text("title", "  Hi  ")).toEqual({ ok: true, value: "Hi" });
    expect(text("url", "   ")).toEqual({ ok: true, value: null });
    expect(text("email", " a@b.test ")).toEqual({ ok: true, value: "a@b.test" });
    expect(text("text", " words ")).toEqual({ ok: true, value: [{ text: "words", marks: [] }] });
    expect(text("text", "")).toEqual({ ok: true, value: null });
  });

  it("parses numbers by the property's format and refuses what is not a number", () => {
    expect(text("number", "1,234.5", { format: "number" })).toEqual({ ok: true, value: 1234.5 });
    expect(text("number", "25%", { format: "percent" })).toEqual({ ok: true, value: 0.25 });
    expect(text("number", "", { format: "number" })).toEqual({ ok: true, value: null });
    expect(text("number", "abc", { format: "number" })).toEqual({
      ok: false,
      message: NUMBER_ERROR,
    });
  });

  it.each<[string, string, number | null | undefined]>([
    [",", "1,5", 1.5],
    [",", "1.234,5", 1234.5],
    [",", "1.500", 1500],
    [",", "1.5", undefined],
    [",", "1,234.5", undefined],
    [".", "1,234.5", 1234.5],
    [".", "1,500", 1500],
    [".", "1,5", undefined],
  ])("reads numbers under the %j separator: %j", (separator, input, expected) => {
    const result = text("number", input, { format: "number" }, separator);
    expect(result).toEqual(
      expected === undefined ? { ok: false, message: NUMBER_ERROR } : { ok: true, value: expected },
    );
  });

  it("finds the decimal separator without throwing, falling back to toLocaleString", () => {
    const boom = () => {
      throw new TypeError("formatToParts is not a function");
    };
    expect(detectDecimalSeparator(() => ",", boom)).toBe(",");
    expect(detectDecimalSeparator(boom, () => "1,1")).toBe(",");
    expect(
      detectDecimalSeparator(
        () => undefined,
        () => "1.1",
      ),
    ).toBe(".");
    expect(detectDecimalSeparator(boom, boom)).toBe(".");
    expect(detectDecimalSeparator(boom, () => "weird")).toBe(".");
  });

  it("commits dates without a time, raises a short end, and explains what is wrong", () => {
    const editor = editorFor(property("p", "Due", "date"), undefined);
    const date = (start: string, end = "") => commitValue(editor, { kind: "date", start, end });
    expect(date("2026-11-05")).toEqual({ ok: true, value: { start: "2026-11-05" } });
    expect(date("2026-11-05", "2026-11-07")).toEqual({
      ok: true,
      value: { start: "2026-11-05", end: "2026-11-07" },
    });
    expect(date("2026-11-05", "2026-11-01")).toEqual({
      ok: true,
      value: { start: "2026-11-05", end: "2026-11-05" },
    });
    expect(date("", "")).toEqual({ ok: true, value: null });
    expect(date("", "2026-11-05")).toEqual({ ok: false, message: DATE_START_ERROR });
    expect(date("2026-02-30")).toEqual({ ok: false, message: DATE_ERROR });
    expect(date("2026-11-05", "soon")).toEqual({ ok: false, message: DATE_ERROR });
  });

  it("commits one option, several, or none, and refuses an option that is gone", () => {
    const single = editorFor(property("p", "Kind", "select", { options }), undefined);
    expect(commitValue(single, { kind: "choice", selected: ["b"] })).toEqual({
      ok: true,
      value: "b",
    });
    expect(commitValue(single, { kind: "choice", selected: [] })).toEqual({
      ok: true,
      value: null,
    });
    const multi = editorFor(property("p", "Tags", "multi_select", { options }), undefined);
    expect(commitValue(multi, { kind: "choice", selected: ["a", "b"] })).toEqual({
      ok: true,
      value: ["a", "b"],
    });
    expect(commitValue(multi, { kind: "choice", selected: ["gone"] })).toMatchObject({ ok: false });
  });

  it("stores a checkbox as true or empty", () => {
    expect(commitCheckbox(true)).toBe(true);
    expect(commitCheckbox(false)).toBeNull();
  });
});

describe("newRowInput", () => {
  const prio = property("prio", "Priority", "select", { options });
  const source = {
    ...dataSource([property("title", "Name", "title"), prio]),
    defaultTemplateId: "tpl",
    templates: [{ pageId: "tpl" }],
  };
  const filtered = view("table", {
    filter: { property: "prio", operator: "equals", value: "b" },
  });

  it("seeds the filter's value and the default template, and trims the title", () => {
    expect(
      newRowInput({
        view: filtered,
        dataSource: source as never,
        title: "  New  ",
        now: 0,
        zone: "UTC",
      }),
    ).toEqual({
      dataSourceId: "source1",
      rows: [{ title: "New", cells: { prio: "b" }, templateId: "tpl" }],
    });
  });

  it("dates a row added from a calendar or timeline view so the view lists it", () => {
    const due = property("due", "Due", "date");
    const withDate = dataSource([property("title", "Name", "title"), due]);
    const day = Date.UTC(2026, 10, 5);
    expect(
      newRowInput({
        view: view("calendar", { layout: { datePropertyId: "due" } }),
        dataSource: withDate,
        title: "",
        now: day,
        zone: "UTC",
      }).rows[0]?.cells,
    ).toEqual({ due: { start: "2026-11-05" } });
    expect(
      newRowInput({
        view: view("timeline", { layout: { startPropertyId: "due" } }),
        dataSource: withDate,
        title: "",
        now: day,
        zone: "UTC",
      }).rows[0]?.cells,
    ).toEqual({ due: { start: "2026-11-05" } });
  });

  it("sends a bare row for an empty title and an unfiltered view", () => {
    expect(
      newRowInput({
        view: view("table"),
        dataSource: dataSource([prio]),
        title: " ",
        now: 0,
        zone: "UTC",
      }),
    ).toEqual({ dataSourceId: "source1", rows: [{}] });
  });
});
