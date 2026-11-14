import * as C from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { type FormQuestion, formDraft } from "./Form.ts";

const question = (
  propertyId: string,
  type: FormQuestion["type"],
  extra: Partial<FormQuestion> = {},
): FormQuestion => ({
  propertyId: C.SpacePropertyId.make(propertyId),
  type,
  label: propertyId,
  required: false,
  ...extra,
});
const questions = [
  question("title", "title", { required: true }),
  question("note", "text"),
  question("size", "number"),
  question("mail", "email"),
  question("kind", "select", {
    options: [{ id: C.SpaceOptionId.make("a"), name: "A", color: "red" }],
  }),
  question("tags", "multi_select", {
    options: [
      { id: C.SpaceOptionId.make("a"), name: "A", color: "red" },
      { id: C.SpaceOptionId.make("b"), name: "B", color: "blue" },
    ],
  }),
  question("due", "date"),
  question("ok", "checkbox", { required: false }),
];

describe("formDraft", () => {
  it.each([
    ["an unknown key", { title: "t", extra: "x" }, { problem: "unknown_question" }],
    ["a required title left empty", { title: "  " }, { propertyId: "title", problem: "required" }],
    [
      "too long text",
      { title: "t", note: "x".repeat(2001) },
      { propertyId: "note", problem: "too_long" },
    ],
    ["a bad email", { title: "t", mail: "nope" }, { propertyId: "mail", problem: "invalid" }],
    [
      "an unknown option",
      { title: "t", kind: "zz" },
      { propertyId: "kind", problem: "unknown_option" },
    ],
    [
      "a multi with an unknown id",
      { title: "t", tags: ["a", "zz"] },
      { propertyId: "tags", problem: "unknown_option" },
    ],
    [
      "duplicate multi ids",
      { title: "t", tags: ["a", "a"] },
      { propertyId: "tags", problem: "invalid" },
    ],
    [
      "a bad calendar day",
      { title: "t", due: "2026-02-30" },
      { propertyId: "due", problem: "invalid" },
    ],
    [
      "a number given as a string",
      { title: "t", size: "3" },
      { propertyId: "size", problem: "invalid" },
    ],
  ])("refuses %s", (_name, answers, expected) => {
    expect(formDraft(questions, answers)).toEqual({ ok: false, ...expected });
  });

  it("refuses an empty required checkbox", () => {
    const required = [question("ok", "checkbox", { required: true })];
    expect(formDraft(required, { ok: false })).toEqual({
      ok: false,
      propertyId: "ok",
      problem: "required",
    });
  });

  it("puts the title in title, text as runs and dates as start, and skips optional empties", () => {
    expect(
      formDraft(questions, {
        title: " Hello ",
        note: "body",
        size: 4,
        kind: "a",
        tags: ["b"],
        due: "2026-03-01",
        mail: "",
        ok: true,
      }),
    ).toEqual({
      ok: true,
      title: "Hello",
      cells: {
        note: [{ text: "body", marks: [] }],
        size: 4,
        kind: "a",
        tags: ["b"],
        due: { start: "2026-03-01" },
        ok: true,
      },
    });
  });
});
