import {
  formAnswerEmpty,
  formAnswerProblem,
  isFormAnswerType,
  type SpaceCellValue,
  type SpaceDataSource,
  type SpaceFormAnswerProblem,
  type SpaceFormAnswerType,
  type SpaceKnownDatabaseView,
  type SpacePropertyId,
} from "@t2code/contracts/spaces";
import type { SpaceSharedFormQuestion } from "@t2code/contracts";
import type * as Schema from "effect/Schema";

import { knownProperty } from "./schema.ts";

/** Numbers and dates are strings while typing. */
export type FormAnswer = string | boolean | ReadonlyArray<string> | null;
export type FormAnswers = Readonly<Record<string, FormAnswer>>;

export interface FormQuestionModel {
  readonly propertyId: SpacePropertyId;
  readonly type: SpaceFormAnswerType;
  readonly label: string;
  readonly description: string | undefined;
  readonly required: boolean;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly color: string;
  }>;
}

export function formQuestionModels(
  known: Extract<SpaceKnownDatabaseView, { type: "form" }>,
  dataSource: SpaceDataSource,
): ReadonlyArray<FormQuestionModel> {
  return (known.layout.questions ?? []).flatMap((question) => {
    const raw = dataSource.properties[question.propertyId];
    const property = raw === undefined ? null : knownProperty(raw);
    if (property === null || !isFormAnswerType(property.type)) return [];
    const options =
      property.type === "select" || property.type === "multi_select" || property.type === "status"
        ? property.config.options.map(({ id, name, color }) => ({ id, name, color }))
        : [];
    const label = question.label?.trim();
    return [
      {
        propertyId: question.propertyId,
        type: property.type,
        label: label === undefined || label === "" ? property.name : label,
        description: question.description,
        required: question.required === true,
        options,
      },
    ];
  });
}

export function sharedQuestionModels(
  questions: ReadonlyArray<SpaceSharedFormQuestion>,
): ReadonlyArray<FormQuestionModel> {
  return questions.map((question) => ({
    propertyId: question.propertyId,
    type: question.type,
    label: question.label,
    description: question.description,
    required: question.required,
    options: (question.options ?? []).map(({ id, name, color }) => ({ id, name, color })),
  }));
}

type Normalized = { readonly empty: true } | { readonly empty: false; readonly value: unknown };

const NUMBER_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

function normalize(question: FormQuestionModel, answer: FormAnswer | undefined): Normalized {
  const { type } = question;
  if (answer === undefined || answer === null) return { empty: true };
  const value =
    typeof answer !== "string"
      ? answer
      : type === "number"
        ? answer.trim() === ""
          ? ""
          : NUMBER_TEXT.test(answer.trim())
            ? Number(answer.trim())
            : Number.NaN
        : answer.trim();
  return formAnswerEmpty(type, value) ? { empty: true } : { empty: false, value };
}

export function formProblems(
  questions: ReadonlyArray<FormQuestionModel>,
  answers: FormAnswers,
): Readonly<Record<string, SpaceFormAnswerProblem>> {
  const problems: Record<string, SpaceFormAnswerProblem> = {};
  for (const question of questions) {
    const normalized = normalize(question, answers[question.propertyId]);
    if (normalized.empty) {
      if (question.required) problems[question.propertyId] = "required";
      continue;
    }
    const problem = formAnswerProblem(
      question.type,
      normalized.value,
      new Set(question.options.map((option) => option.id)),
    );
    if (problem !== null) problems[question.propertyId] = problem;
  }
  return problems;
}

/** The public wire: empty answers left out, numbers parsed. */
export function formPublicAnswers(
  questions: ReadonlyArray<FormQuestionModel>,
  answers: FormAnswers,
): Record<string, Schema.Json> {
  const out: Record<string, Schema.Json> = {};
  for (const question of questions) {
    const normalized = normalize(question, answers[question.propertyId]);
    if (normalized.empty) continue;
    const { value } = normalized;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      out[question.propertyId] = value;
    else if (Array.isArray(value)) out[question.propertyId] = value.map(String);
  }
  return out;
}

/** The cells of a row created in the app: the title under `title`, text as runs, dates as `{start}`. */
export function formRowDraft(
  questions: ReadonlyArray<FormQuestionModel>,
  answers: FormAnswers,
): { readonly cells: Record<string, SpaceCellValue> } {
  const cells: Record<string, SpaceCellValue> = {};
  const wire = formPublicAnswers(questions, answers);
  for (const question of questions) {
    const value = wire[question.propertyId];
    if (value === undefined) continue;
    if (question.type === "title") cells.title = value;
    else if (question.type === "text")
      cells[question.propertyId] = [{ text: String(value), marks: [] }];
    else if (question.type === "date") cells[question.propertyId] = { start: String(value) };
    else cells[question.propertyId] = value;
  }
  return { cells };
}

/** A fresh submission id from a uuid source: 32 characters. */
export const newSubmissionId = (random: () => string): string => random().replaceAll("-", "");
