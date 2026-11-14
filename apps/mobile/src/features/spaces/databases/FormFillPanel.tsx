import {
  formProblems,
  formQuestionModels,
  knownView,
  type FormAnswer,
  type FormAnswers,
  type FormQuestionModel,
} from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDataSource, SpaceDatabaseView } from "@t2code/contracts/spaces";
import { useRef, useState } from "react";
import { Pressable, Switch, View, useColorScheme } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { appAtomRegistry } from "../../../state/atom-registry";
import { spacesWritable } from "../../../state/spaces";
import { databaseMutations, databaseWriter } from "../../../state/spacesDatabases";
import { submitFormResponse } from "./formResponse";
import { optionColor } from "./optionColors";
import type { DatabaseModel } from "./useDatabaseModel";

const PROBLEM_TEXT = {
  required: "This question is required.",
  invalid: "This answer is not valid.",
  too_long: "This answer is too long.",
  unknown_option: "Pick one of the listed options.",
} as const;

const KEYBOARDS = {
  number: "decimal-pad",
  email: "email-address",
  url: "url",
  phone: "phone-pad",
} as const;

function Choices(props: {
  readonly question: FormQuestionModel;
  readonly value: ReadonlyArray<string>;
  readonly onChange: (value: ReadonlyArray<string>) => void;
}) {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const multi = props.question.type === "multi_select";
  return (
    <View className="flex-row flex-wrap gap-2">
      {props.question.options.map((option) => {
        const selected = props.value.includes(option.id);
        const color = optionColor(option.color, scheme);
        return (
          <Pressable
            key={option.id}
            accessibilityRole={multi ? "checkbox" : "radio"}
            accessibilityState={{ checked: selected }}
            className="rounded-full border px-3 py-1.5"
            style={{
              backgroundColor: selected ? color.background : "transparent",
              borderColor: color.background,
            }}
            onPress={() =>
              props.onChange(
                multi
                  ? selected
                    ? props.value.filter((id) => id !== option.id)
                    : [...props.value, option.id]
                  : selected
                    ? []
                    : [option.id],
              )
            }
          >
            <Text className="text-sm" style={selected ? { color: color.text } : undefined}>
              {option.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Field(props: {
  readonly question: FormQuestionModel;
  readonly answer: FormAnswer | undefined;
  readonly disabled: boolean;
  readonly onChange: (answer: FormAnswer) => void;
}) {
  const { question, answer } = props;
  switch (question.type) {
    case "checkbox":
      return (
        <Switch
          accessibilityLabel={question.label}
          value={answer === true}
          disabled={props.disabled}
          onValueChange={props.onChange}
        />
      );
    case "select":
    case "status":
    case "multi_select":
      return (
        <Choices
          question={question}
          value={Array.isArray(answer) ? answer : typeof answer === "string" ? [answer] : []}
          onChange={(ids) =>
            props.onChange(question.type === "multi_select" ? ids : (ids[0] ?? null))
          }
        />
      );
    default:
      return (
        <TextInput
          accessibilityLabel={question.label}
          placeholder={question.type === "date" ? "YYYY-MM-DD" : undefined}
          value={typeof answer === "string" ? answer : ""}
          onChangeText={props.onChange}
          editable={!props.disabled}
          multiline={question.type === "text"}
          autoCapitalize={
            question.type === "title" || question.type === "text" ? "sentences" : "none"
          }
          keyboardType={
            question.type === "number" ||
            question.type === "email" ||
            question.type === "url" ||
            question.type === "phone"
              ? KEYBOARDS[question.type]
              : "default"
          }
        />
      );
  }
}

/** Fills the form view and submits one row. Offered only where the connection can add rows. */
export function FormFillPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly model: DatabaseModel;
  readonly view: SpaceDatabaseView;
  readonly dataSource: SpaceDataSource;
}) {
  const known = knownView(props.view);
  const questions =
    known === null || known.type !== "form" ? [] : formQuestionModels(known, props.dataSource);
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  if (!props.model.canAddRows)
    return (
      <Text className="px-4 py-2 text-base text-foreground-muted">
        You can't add responses to this database.
      </Text>
    );
  if (questions.length === 0)
    return (
      <Text className="px-4 py-2 text-base text-foreground-muted">
        This form has no questions yet. Add them on desktop.
      </Text>
    );
  if (sent)
    return (
      <View className="items-start gap-2 px-4 py-3">
        <Text accessibilityLiveRegion="polite" className="text-base font-semibold text-foreground">
          Response recorded
        </Text>
        <ControlPill
          variant="pill"
          label="Submit another"
          onPress={() => {
            setAnswers({});
            setChecked(false);
            setSent(false);
          }}
        />
      </View>
    );
  const problems = formProblems(questions, answers);
  const submit = async () => {
    if (sending.current) return;
    setChecked(true);
    if (Object.keys(problems).length > 0) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const result = await submitFormResponse({
      environmentId: props.environmentId,
      registry: appAtomRegistry,
      mutations: databaseMutations,
      writer: databaseWriter(props.environmentId),
      canWrite: () => spacesWritable(props.environmentId),
      dataSource: props.dataSource,
      questions,
      answers,
    });
    sending.current = false;
    setBusy(false);
    if (result.ok) setSent(true);
    else setError(result.message);
  };
  return (
    <View className="gap-4 px-4 py-2">
      {questions.map((question) => {
        const problem = checked ? problems[question.propertyId] : undefined;
        return (
          <View key={question.propertyId} className="gap-1.5">
            <Text className="text-base font-semibold text-foreground">
              {question.label}
              {question.required ? " *" : ""}
            </Text>
            {question.description === undefined || question.description === "" ? null : (
              <Text className="text-sm text-foreground-muted">{question.description}</Text>
            )}
            <Field
              question={question}
              answer={answers[question.propertyId]}
              disabled={busy}
              onChange={(answer) =>
                setAnswers((current) => ({ ...current, [question.propertyId]: answer }))
              }
            />
            {problem === undefined ? null : (
              <Text className="text-sm text-danger-foreground">{PROBLEM_TEXT[problem]}</Text>
            )}
          </View>
        );
      })}
      {error === null ? null : (
        <Text accessibilityLiveRegion="polite" className="text-sm text-danger-foreground">
          {error}
        </Text>
      )}
      <View className="flex-row">
        <ControlPill
          variant="primary"
          label={busy ? "Submitting…" : "Submit"}
          disabled={busy}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}
