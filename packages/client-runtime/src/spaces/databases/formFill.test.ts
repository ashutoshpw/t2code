import type { SpaceSharedFormQuestion } from "@t2code/contracts";
import type { SpaceDataSource, SpaceKnownDatabaseView } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import {
  formProblems,
  formPublicAnswers,
  formQuestionModels,
  formRowDraft,
  newSubmissionId,
  sharedQuestionModels,
} from "./formFill.ts";

const prop = (id: string, type: string, config: object = {}) => ({
  id,
  name: `N-${id}`,
  type,
  config,
  position: 0,
});
const source = {
  properties: {
    title: prop("title", "title"),
    note: prop("note", "text"),
    size: prop("size", "number", { format: "number" }),
    kind: prop("kind", "select", {
      options: [{ id: "x", name: "X", color: "red" }],
    }),
    due: prop("due", "date"),
    ok: prop("ok", "checkbox"),
    rel: prop("rel", "relation", { dataSourceId: "ds" }),
  },
} as unknown as SpaceDataSource;
const form = (questions: unknown[]) =>
  ({ type: "form", layout: { questions } }) as unknown as Extract<
    SpaceKnownDatabaseView,
    { type: "form" }
  >;
const models = formQuestionModels(
  form([
    { propertyId: "title", required: true, label: " Name " },
    { propertyId: "note" },
    { propertyId: "size" },
    { propertyId: "kind", required: true },
    { propertyId: "due" },
    { propertyId: "ok", required: true },
    { propertyId: "rel" },
    { propertyId: "gone" },
  ]),
  source,
);

describe("form models", () => {
  it("skips dead and non-answer properties and falls back to the property name", () => {
    expect(models.map((model) => model.propertyId)).toEqual([
      "title",
      "note",
      "size",
      "kind",
      "due",
      "ok",
    ]);
    expect(models[0]?.label).toBe("Name");
    expect(models[1]?.label).toBe("N-note");
    expect(models[3]?.options).toEqual([{ id: "x", name: "X", color: "red" }]);
    const shared: SpaceSharedFormQuestion = {
      propertyId: "size" as never,
      type: "number",
      label: "Size",
      required: false,
    };
    expect(sharedQuestionModels([shared])[0]).toMatchObject({ label: "Size", options: [] });
  });
});

describe("form answers", () => {
  it("reports required, invalid and unknown option problems", () => {
    expect(formProblems(models, {})).toEqual({
      title: "required",
      kind: "required",
      ok: "required",
    });
    expect(
      formProblems(models, {
        title: "  ",
        kind: "nope",
        ok: false,
        size: "12abc",
        due: "2026-02-30",
      }),
    ).toEqual({
      title: "required",
      kind: "unknown_option",
      ok: "required",
      size: "invalid",
      due: "invalid",
    });
    expect(
      formProblems(models, { title: "a", kind: "x", ok: true, size: " 4.5 ", due: "2026-02-28" }),
    ).toEqual({});
  });

  it("sends only filled answers, with numbers parsed", () => {
    expect(
      formPublicAnswers(models, { title: " Hi ", size: "3", note: "", kind: "x", ok: true }),
    ).toEqual({ title: "Hi", size: 3, kind: "x", ok: true });
  });

  it("builds a row draft with the title under title, text as runs and dates as start", () => {
    expect(
      formRowDraft(models, { title: "Hi", note: "body", due: "2026-03-01", kind: "x" }).cells,
    ).toEqual({
      title: "Hi",
      note: [{ text: "body", marks: [] }],
      due: { start: "2026-03-01" },
      kind: "x",
    });
    expect(newSubmissionId(() => "a1b2-c3d4")).toBe("a1b2c3d4");
  });
});
