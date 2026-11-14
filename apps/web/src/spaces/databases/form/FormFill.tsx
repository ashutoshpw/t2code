import {
  formProblems,
  formRowDraft,
  type FormAnswer,
  type FormAnswers,
  type FormQuestionModel,
} from "@t2code/client-runtime/spaces";
import { CircleCheckIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { useDatabase, useDatabaseActions } from "../shell/context";
import { FormFields, focusFirstInvalid } from "./FormFields";

type Phase = "idle" | "sending" | "sent";

/** The form as a respondent sees it. A submit creates one row through the normal row path. */
export function FormFill({ questions }: { readonly questions: ReadonlyArray<FormQuestionModel> }) {
  const { model, view, known } = useDatabase();
  const actions = useDatabaseActions();
  const formRef = useRef<HTMLFormElement>(null);
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [shown, setShown] = useState(false);
  const problems = shown ? formProblems(questions, answers) : {};
  const description = known?.type === "form" ? known.layout.description : undefined;

  if (!model.permissions.rows)
    return (
      <p className="text-muted-foreground text-sm">You can't add responses to this database.</p>
    );

  const submit = async () => {
    if (phase === "sending") return;
    setShown(true);
    if (Object.keys(formProblems(questions, answers)).length > 0) {
      // Fields render their problems on the next commit; focus once they exist.
      queueMicrotask(() => formRef.current && focusFirstInvalid(formRef.current));
      return;
    }
    setPhase("sending");
    const row = await actions.createRow({
      cells: formRowDraft(questions, answers).cells,
      templateId: null,
    });
    setPhase(row === null ? "idle" : "sent");
  };

  if (phase === "sent")
    return (
      <div role="status" className="flex flex-col items-start gap-3 py-6">
        <p className="flex items-center gap-2 font-medium text-sm">
          <CircleCheckIcon className="size-4" />
          Response recorded
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setAnswers({});
            setShown(false);
            setPhase("idle");
          }}
        >
          Submit another response
        </Button>
      </div>
    );

  return (
    <form
      ref={formRef}
      noValidate
      className="flex max-w-xl flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
        )
          event.preventDefault();
      }}
    >
      <header className="flex flex-col gap-1">
        <h2 className="font-semibold text-xl">{view.name}</h2>
        {description === undefined || description === "" ? null : (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </header>
      <FormFields
        questions={questions}
        answers={answers}
        problems={problems}
        disabled={phase === "sending"}
        onChange={(propertyId: string, answer: FormAnswer) =>
          setAnswers((current) => ({ ...current, [propertyId]: answer }))
        }
      />
      <Button type="submit" className="self-start" disabled={phase === "sending"}>
        Submit
      </Button>
    </form>
  );
}
