import type { SpaceSharedForm, SpaceSharedFormQuestion } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";

import { type Json, isObject } from "../databases/Json.ts";
import type { Property } from "../databases/SchemaStore.ts";
import { formQuestionIds } from "./Exposure.ts";
import type { ViewScope } from "./Scope.ts";

export type FormQuestion = SpaceSharedFormQuestion;

const layoutEntry = (scope: ViewScope, propertyId: string) => {
  const questions = scope.shape.layout.questions;
  return Array.isArray(questions)
    ? questions.find((entry) => isObject(entry) && entry.propertyId === propertyId)
    : undefined;
};

const optionsOf = (property: Property) =>
  property.options.map((option) => ({
    id: C.SpaceOptionId.make(option.option_id),
    name: option.name,
    color: option.color,
    ...(property.type === "status" && option.status_group !== null
      ? { group: option.status_group }
      : {}),
  }));

/** The questions a link may ask: the title when listed, and the exposed answerable properties, in layout order. */
export const formQuestions = (scope: ViewScope): readonly FormQuestion[] => {
  const exposed = new Set(scope.exposed.extras);
  const out: FormQuestion[] = [];
  for (const id of formQuestionIds(scope.shape)) {
    const property = scope.snapshot.byId.get(id);
    const isTitle = id === C.SPACE_TITLE_PROPERTY_ID;
    if (!isTitle && (!exposed.has(id) || property === undefined)) continue;
    const type = isTitle ? "title" : property?.type;
    if (type === undefined || !C.isFormAnswerType(type)) continue;
    const entry = layoutEntry(scope, id);
    const label = isObject(entry) && typeof entry.label === "string" ? entry.label.trim() : "";
    const description =
      isObject(entry) && typeof entry.description === "string" && entry.description.trim() !== ""
        ? entry.description
        : undefined;
    const format = property?.config.format;
    out.push({
      propertyId: C.SpacePropertyId.make(id),
      type,
      label: label !== "" ? label : (property?.name ?? "Title"),
      ...(description === undefined ? {} : { description }),
      required: isObject(entry) && entry.required === true,
      ...(property !== undefined &&
      (type === "select" || type === "multi_select" || type === "status")
        ? { options: optionsOf(property) }
        : {}),
      ...(type === "number" && typeof format === "string" ? { numberFormat: format } : {}),
    });
  }
  return out;
};

export const describeForm = (scope: ViewScope): SpaceSharedForm => {
  const description = scope.shape.layout.description;
  const name = scope.view.name.trim();
  return {
    viewId: scope.view.view_id,
    title: name === "" ? scope.block.database.title : name,
    ...(typeof description === "string" && description !== "" ? { description } : {}),
    questions: formQuestions(scope),
  };
};

export type FormDraft =
  | { readonly ok: true; readonly title?: string; readonly cells: Record<string, Json> }
  | {
      readonly ok: false;
      readonly propertyId?: C.SpacePropertyId;
      readonly problem: C.SpaceFormAnswerProblem | "unknown_question";
    };

const TRIMMED = new Set<string>(["title", "text", "url", "email", "phone"]);

/** Checks the answers against the questions and builds the row cells. Unknown keys are refused. */
export const formDraft = (
  questions: readonly FormQuestion[],
  answers: Readonly<Record<string, Json>>,
): FormDraft => {
  const known = new Set<string>(questions.map((question) => question.propertyId));
  for (const key of Object.keys(answers))
    if (!known.has(key)) return { ok: false, problem: "unknown_question" };
  const cells: Record<string, Json> = {};
  let title: string | undefined;
  for (const question of questions) {
    const raw = answers[question.propertyId];
    const value = typeof raw === "string" && TRIMMED.has(question.type) ? raw.trim() : raw;
    if (C.formAnswerEmpty(question.type, value)) {
      if (question.required)
        return { ok: false, propertyId: question.propertyId, problem: "required" };
      continue;
    }
    const optionIds = question.options && new Set(question.options.map((option) => option.id));
    const problem = C.formAnswerProblem(question.type, value, optionIds);
    if (problem !== null) return { ok: false, propertyId: question.propertyId, problem };
    if (value === undefined) continue;
    if (question.type === "title") title = String(value);
    else if (question.type === "text")
      cells[question.propertyId] = [{ text: String(value), marks: [] }];
    else if (question.type === "date") cells[question.propertyId] = { start: String(value) };
    else cells[question.propertyId] = value;
  }
  return { ok: true, ...(title === undefined ? {} : { title }), cells };
};
