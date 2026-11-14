import type { FormAnswer, FormAnswers, FormQuestionModel } from "@t2code/client-runtime/spaces";
import {
  SPACE_FORM_SHORT_MAX,
  SPACE_FORM_TEXT_MAX,
  type SpaceFormAnswerProblem,
} from "@t2code/contracts/spaces";
import { useId } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Radio, RadioGroup } from "~/components/ui/radio-group";
import { Textarea } from "~/components/ui/textarea";
import { OptionChip } from "../primitives/OptionChip";

const PROBLEM_TEXT: Record<SpaceFormAnswerProblem, string> = {
  required: "Answer this question.",
  invalid: "Check this answer.",
  too_long: "This answer is too long.",
  unknown_option: "Choose one of the options.",
};

const INPUT_TYPE = { url: "url", email: "email", phone: "tel", date: "date" } as const;

interface FormFieldsProps {
  readonly questions: ReadonlyArray<FormQuestionModel>;
  readonly answers: FormAnswers;
  readonly problems: Readonly<Record<string, SpaceFormAnswerProblem>>;
  readonly onChange: (propertyId: string, answer: FormAnswer) => void;
  readonly disabled: boolean;
}

/** Every question of a form as a labelled field. Shared by the in-app form and the public page. */
export function FormFields({ questions, answers, problems, onChange, disabled }: FormFieldsProps) {
  const base = useId();
  return (
    <div className="flex flex-col gap-5">
      {questions.map((question, index) => (
        <Field
          key={question.propertyId}
          id={`${base}-${index}`}
          question={question}
          answer={answers[question.propertyId] ?? null}
          problem={problems[question.propertyId]}
          onChange={(answer) => onChange(question.propertyId, answer)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function Field({
  id,
  question,
  answer,
  problem,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly question: FormQuestionModel;
  readonly answer: FormAnswer;
  readonly problem: SpaceFormAnswerProblem | undefined;
  readonly onChange: (answer: FormAnswer) => void;
  readonly disabled: boolean;
}) {
  const hintId = `${id}-hint`;
  const problemId = `${id}-problem`;
  const describedBy =
    [
      question.description === undefined || question.description === "" ? null : hintId,
      problem === undefined ? null : problemId,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const shared = {
    id,
    disabled,
    "aria-invalid": problem === undefined ? undefined : true,
    "aria-describedby": describedBy,
  } as const;
  const text = typeof answer === "string" ? answer : "";
  const selected = Array.isArray(answer) ? answer : [];

  const control = (() => {
    switch (question.type) {
      case "text":
        return (
          <Textarea
            {...shared}
            maxLength={SPACE_FORM_TEXT_MAX}
            value={text}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case "number":
        return (
          <Input
            {...shared}
            inputMode="decimal"
            maxLength={SPACE_FORM_SHORT_MAX}
            value={text}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case "checkbox":
        return (
          <Label className="w-fit">
            <Checkbox
              {...shared}
              checked={answer === true}
              onCheckedChange={(checked) => onChange(checked)}
            />
            Yes
          </Label>
        );
      case "select":
      case "status":
        return (
          <div className="flex flex-col items-start gap-1.5">
            <RadioGroup
              id={id}
              aria-labelledby={`${id}-label`}
              aria-invalid={shared["aria-invalid"]}
              aria-describedby={describedBy}
              disabled={disabled}
              value={text}
              onValueChange={(value) => onChange(String(value))}
            >
              {question.options.map((option) => (
                <Label key={option.id}>
                  <Radio value={option.id} />
                  <OptionChip name={option.name} color={option.color} />
                </Label>
              ))}
            </RadioGroup>
            {text !== "" && !question.required ? (
              <Button
                type="button"
                variant="ghost-muted"
                size="xs"
                disabled={disabled}
                onClick={() => onChange(null)}
              >
                Clear
              </Button>
            ) : null}
          </div>
        );
      case "multi_select":
        return (
          <div
            id={id}
            role="group"
            aria-labelledby={`${id}-label`}
            aria-describedby={describedBy}
            className="flex flex-col gap-1.5"
          >
            {question.options.map((option) => (
              <Label key={option.id} className="w-fit">
                <Checkbox
                  disabled={disabled}
                  aria-invalid={shared["aria-invalid"]}
                  checked={selected.includes(option.id)}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked
                        ? [...selected, option.id]
                        : selected.filter((chosen) => chosen !== option.id),
                    )
                  }
                />
                <OptionChip name={option.name} color={option.color} />
              </Label>
            ))}
          </div>
        );
      case "title":
      case "url":
      case "email":
      case "phone":
      case "date":
        return (
          <Input
            {...shared}
            {...(question.type === "title" ? {} : { type: INPUT_TYPE[question.type] })}
            maxLength={SPACE_FORM_SHORT_MAX}
            value={text}
            onChange={(e) => onChange(e.target.value)}
          />
        );
    }
  })();

  return (
    <div
      data-form-field
      data-invalid={problem === undefined ? undefined : ""}
      className="flex flex-col gap-1.5"
    >
      <Label id={`${id}-label`} htmlFor={id}>
        {question.label}
        {question.required ? (
          <>
            <span aria-hidden="true">*</span>
            <span className="sr-only">required</span>
          </>
        ) : null}
      </Label>
      {question.description === undefined || question.description === "" ? null : (
        <p id={hintId} className="text-muted-foreground text-xs">
          {question.description}
        </p>
      )}
      {control}
      {problem === undefined ? null : (
        <p id={problemId} role="alert" className="text-destructive-foreground text-xs">
          {PROBLEM_TEXT[problem]}
        </p>
      )}
    </div>
  );
}

/** Moves focus to the first field with a problem. */
export function focusFirstInvalid(form: HTMLElement): void {
  form
    .querySelector<HTMLElement>(
      "[data-invalid] :is(input, textarea, [role=radio], [role=checkbox], button)",
    )
    ?.focus();
}
