import { formQuestionModels } from "@t2code/client-runtime/spaces";

import { useViewControls } from "../controls/useViewControls";
import { useDatabase } from "../shell/context";
import type { DatabaseViewProps } from "../shell/viewTypes";
import { FormBuilder } from "./FormBuilder";
import { FormFill } from "./FormFill";

/** A form has no query: its questions are properties named by the view. */
export default function FormView(_props: DatabaseViewProps) {
  const { known, dataSource } = useDatabase();
  const { canEditView } = useViewControls();
  if (known?.type !== "form") return null;
  const questions = formQuestionModels(known, dataSource);
  if (canEditView) return <FormBuilder questions={questions} />;
  if (questions.length === 0)
    return <p className="text-muted-foreground text-sm">This form has no questions.</p>;
  return <FormFill questions={questions} />;
}
