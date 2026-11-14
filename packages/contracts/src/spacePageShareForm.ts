import * as Schema from "effect/Schema";

import { SPACE_PAGE_SHARE_ROUTE_PREFIX } from "./spacePageShare.ts";
import { SpaceSharedOption } from "./spacePageShareDatabase.ts";
import {
  SPACE_FORM_ANSWER_TYPES,
  SpaceBlockId,
  SpacePageId,
  SpacePropertyId,
  SpaceViewId,
} from "./spaces.ts";

/** A public form: the view's questions are served, and answers are accepted, only while the share accepts responses. */
export const SPACE_PAGE_SHARE_FORM_ROUTE = `${SPACE_PAGE_SHARE_ROUTE_PREFIX}/database/form`;
/** Viewer URL flag: `?page&block&view&form=1`. */
export const SPACE_PAGE_SHARE_FORM_PARAM = "form";
export const SPACE_FORM_SUBMISSION_MAX_BYTES = 16_384;
const SPACE_FORM_SUBMISSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const optional = Schema.optionalKey;

export const SpaceSharedFormQuestion = Schema.Struct({
  propertyId: SpacePropertyId,
  type: Schema.Literals(SPACE_FORM_ANSWER_TYPES),
  /** The question label, or the property name. */
  label: Schema.String,
  description: optional(Schema.String),
  required: Schema.Boolean,
  /** Select, multi_select and status: every option. */
  options: optional(Schema.Array(SpaceSharedOption)),
  /** Number questions: the property's format word. */
  numberFormat: optional(Schema.String),
});
export type SpaceSharedFormQuestion = typeof SpaceSharedFormQuestion.Type;

export const SpaceSharedForm = Schema.Struct({
  viewId: SpaceViewId,
  /** The view name, or the database title when it is empty. */
  title: Schema.String,
  description: optional(Schema.String),
  questions: Schema.Array(SpaceSharedFormQuestion),
});
export type SpaceSharedForm = typeof SpaceSharedForm.Type;

export const SpaceSharedFormSubmission = Schema.Struct({
  page: optional(SpacePageId),
  block: SpaceBlockId,
  view: SpaceViewId,
  submissionId: Schema.String.check(Schema.isPattern(SPACE_FORM_SUBMISSION_ID_PATTERN)),
  answers: Schema.Record(Schema.String, Schema.Json),
});
export type SpaceSharedFormSubmission = typeof SpaceSharedFormSubmission.Type;

export const SpaceSharedFormReceived = Schema.Struct({ status: Schema.Literal("received") });
export type SpaceSharedFormReceived = typeof SpaceSharedFormReceived.Type;

export const SpaceSharedFormRejection = Schema.Struct({
  reason: Schema.Literal("rejected"),
  message: Schema.String,
  propertyId: optional(SpacePropertyId),
  problem: optional(
    Schema.Literals(["required", "invalid", "too_long", "unknown_option", "unknown_question"]),
  ),
});
export type SpaceSharedFormRejection = typeof SpaceSharedFormRejection.Type;
