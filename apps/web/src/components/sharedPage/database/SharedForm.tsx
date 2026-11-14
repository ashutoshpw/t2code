import {
  formProblems,
  formPublicAnswers,
  newSubmissionId,
  sharedQuestionModels,
  type FormAnswer,
  type FormAnswers,
} from "@t2code/client-runtime/spaces";
import type {
  SpaceSharedDataSource,
  SpaceSharedDatabaseView,
  SpaceSharedForm,
} from "@t2code/contracts";
import { SpaceBlockId, SpacePageId, type SpaceFormAnswerProblem } from "@t2code/contracts/spaces";
import { CircleCheckIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import { randomUUID } from "~/lib/utils";
import { Skeleton } from "~/components/ui/skeleton";
import { FormFields, focusFirstInvalid } from "~/spaces/databases/form/FormFields";
import { fetchSharedForm, submitSharedForm, type FormFetched } from "./formRequest";
import { ProblemNote, type SharedEnv } from "./parts";

const GENERAL = "Check your answers and try again.";
const NOTICE = {
  busy: "Too many responses right now. Try again in a minute.",
  offline: "Can't reach the owner right now. Try again in a moment.",
  closed: "This form is not accepting responses.",
  ended: "This link no longer works.",
  invalid: GENERAL,
} as const;

/** A form view inside a shared database. */
export function SharedForm({
  env,
  view,
}: {
  readonly env: SharedEnv;
  readonly view: SpaceSharedDatabaseView;
  readonly source: SpaceSharedDataSource;
}) {
  return (
    <SharedFormPage
      credential={env.credential}
      pageId={env.pageId}
      blockId={env.blockId}
      viewId={view.id}
    />
  );
}

/** Fetches a form's questions and takes its answers. Also the whole page of a form link. */
export function SharedFormPage({
  credential,
  pageId,
  blockId,
  viewId,
}: {
  readonly credential: string;
  readonly pageId: string | undefined;
  readonly blockId: string;
  readonly viewId: string;
}) {
  const [loaded, setLoaded] = useState<FormFetched | null>(null);

  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Fetches the form's questions from the network when the link or view changes.
  useEffect(() => {
    const controller = new AbortController();
    void fetchSharedForm(
      credential,
      { ...(pageId === undefined ? {} : { page: pageId }), block: blockId, view: viewId },
      controller.signal,
    ).then((result) => {
      if (!controller.signal.aborted) setLoaded(result);
    });
    return () => controller.abort();
  }, [credential, pageId, blockId, viewId]);

  if (loaded === null)
    return (
      <div role="status" aria-label="Loading form" className="flex flex-col gap-2 py-2">
        <Skeleton className="h-7 w-1/2" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  if (!loaded.ok)
    return loaded.problem === "closed" ? (
      <p role="status" className="py-4 text-muted-foreground text-sm">
        {NOTICE.closed}
      </p>
    ) : (
      <ProblemNote problem={loaded.problem} />
    );
  return <FormBody credential={credential} pageId={pageId} blockId={blockId} form={loaded.value} />;
}

type Phase = "idle" | "sending" | "sent";

function FormBody({
  credential,
  form,
  pageId,
  blockId,
}: {
  readonly credential: string;
  readonly form: SpaceSharedForm;
  readonly pageId: string | undefined;
  readonly blockId: string;
}) {
  const questions = sharedQuestionModels(form.questions);
  const formRef = useRef<HTMLFormElement>(null);
  const attempt = useRef<{ readonly id: string; readonly body: string } | null>(null);
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [shown, setShown] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [server, setServer] = useState<Readonly<Record<string, SpaceFormAnswerProblem>>>({});
  const problems = { ...server, ...(shown ? formProblems(questions, answers) : {}) };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (phase === "sending") return;
    setShown(true);
    setNotice(null);
    if (Object.keys(formProblems(questions, answers)).length > 0) {
      queueMicrotask(() => formRef.current && focusFirstInvalid(formRef.current));
      return;
    }
    const wire = formPublicAnswers(questions, answers);
    const body = JSON.stringify(wire);
    // A retry of the same answers keeps its id, so a lost reply cannot record the response twice.
    const id = attempt.current?.body === body ? attempt.current.id : newSubmissionId(randomUUID);
    attempt.current = { id, body };
    setPhase("sending");
    const result = await submitSharedForm(credential, {
      ...(pageId === undefined ? {} : { page: SpacePageId.make(pageId) }),
      block: SpaceBlockId.make(blockId),
      view: form.viewId,
      submissionId: id,
      answers: wire,
    });
    if (result.status === "received") {
      attempt.current = null;
      setPhase("sent");
      return;
    }
    setPhase("idle");
    if (result.status === "rejected") {
      const { rejection } = result;
      const problem = rejection?.problem;
      if (
        rejection?.propertyId !== undefined &&
        problem !== undefined &&
        problem !== "unknown_question"
      ) {
        setServer({ [rejection.propertyId]: problem });
        queueMicrotask(() => formRef.current && focusFirstInvalid(formRef.current));
      } else setNotice(GENERAL);
      return;
    }
    setNotice(NOTICE[result.status]);
  };

  if (phase === "sent")
    return (
      <div role="status" className="flex flex-col items-start gap-3 py-6">
        <p className="flex items-center gap-2 font-medium text-sm">
          <CircleCheckIcon className="size-4" />
          Thanks, your response was recorded.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setAnswers({});
            setShown(false);
            setServer({});
            setNotice(null);
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
      className="flex max-w-xl flex-col gap-5 py-2"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
        )
          event.preventDefault();
      }}
    >
      <header className="flex flex-col gap-1">
        <h2 className="font-semibold text-xl">{form.title}</h2>
        {form.description === undefined || form.description === "" ? null : (
          <p className="text-muted-foreground text-sm">{form.description}</p>
        )}
      </header>
      <FormFields
        questions={questions}
        answers={answers}
        problems={problems}
        disabled={phase === "sending"}
        onChange={(propertyId: string, answer: FormAnswer) => {
          setServer({});
          setAnswers((current) => ({ ...current, [propertyId]: answer }));
        }}
      />
      {notice === null ? null : (
        <p role="alert" className="text-destructive-foreground text-sm">
          {notice}
        </p>
      )}
      <Button type="submit" className="self-start" disabled={phase === "sending"}>
        Submit
      </Button>
    </form>
  );
}
