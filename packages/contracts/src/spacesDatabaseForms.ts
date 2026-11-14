import * as Schema from "effect/Schema";

import { SpacePropertyId } from "./spacesDatabases.ts";

export const SPACE_FORM_ANSWER_TYPES = [
  "title",
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "checkbox",
  "date",
  "url",
  "email",
  "phone",
] as const;
export type SpaceFormAnswerType = (typeof SPACE_FORM_ANSWER_TYPES)[number];
export const isFormAnswerType = (type: string): type is SpaceFormAnswerType =>
  (SPACE_FORM_ANSWER_TYPES as ReadonlyArray<string>).includes(type);

export const SPACE_FORM_MAX_QUESTIONS = 50;
export const SPACE_FORM_LABEL_MAX = 200;
export const SPACE_FORM_DESCRIPTION_MAX = 1000;
/** Text answers, in characters. */
export const SPACE_FORM_TEXT_MAX = 2000;
/** Title, url, email and phone answers, in characters. */
export const SPACE_FORM_SHORT_MAX = 500;
const SPACE_FORM_MULTI_MAX = 20;

export const SpaceFormQuestion = Schema.Struct({
  propertyId: SpacePropertyId,
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(SPACE_FORM_LABEL_MAX))),
  description: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(SPACE_FORM_DESCRIPTION_MAX)),
  ),
  required: Schema.optionalKey(Schema.Boolean),
});
export type SpaceFormQuestion = typeof SpaceFormQuestion.Type;

export type SpaceFormAnswerProblem = "required" | "invalid" | "too_long" | "unknown_option";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+()\-.\s]{3,50}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formAnswerEmpty(type: SpaceFormAnswerType, value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return type === "checkbox" && value === false;
}

function realDay(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (lengths[month - 1] ?? 0);
}

/** Called only for non-empty values. */
export function formAnswerProblem(
  type: SpaceFormAnswerType,
  value: unknown,
  optionIds: ReadonlySet<string> | undefined,
): Exclude<SpaceFormAnswerProblem, "required"> | null {
  switch (type) {
    case "text":
      if (typeof value !== "string") return "invalid";
      return value.length > SPACE_FORM_TEXT_MAX ? "too_long" : null;
    case "title":
    case "url":
    case "email":
    case "phone": {
      if (typeof value !== "string") return "invalid";
      if (value.length > SPACE_FORM_SHORT_MAX) return "too_long";
      if (type === "email" && !EMAIL.test(value)) return "invalid";
      if (type === "phone" && !PHONE.test(value)) return "invalid";
      if (type === "url") {
        if (!URL.canParse(value)) return "invalid";
        const protocol = new URL(value).protocol;
        if (protocol !== "http:" && protocol !== "https:") return "invalid";
      }
      return null;
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "invalid";
    case "checkbox":
      return typeof value === "boolean" ? null : "invalid";
    case "date":
      return typeof value === "string" && realDay(value) ? null : "invalid";
    case "select":
    case "status":
      if (typeof value !== "string") return "invalid";
      return optionIds?.has(value) ? null : "unknown_option";
    case "multi_select": {
      if (!Array.isArray(value)) return "invalid";
      if (value.length > SPACE_FORM_MULTI_MAX) return "too_long";
      const seen = new Set<string>();
      for (const id of value) {
        if (typeof id !== "string" || seen.has(id)) return "invalid";
        if (!optionIds?.has(id)) return "unknown_option";
        seen.add(id);
      }
      return null;
    }
  }
}
