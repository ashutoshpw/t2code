import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import type { Json } from "../databases/Json.ts";
import { notFound } from "../databases/Types.ts";
import * as Receipts from "../Receipts.ts";
import { describeForm, formDraft, formQuestions } from "../sharedDatabases/Form.ts";
import { resolveView } from "../sharedDatabases/Scope.ts";
import { decodeRequest, isServiceError, validateRaw } from "./Helpers.ts";
import { commitRequest } from "./Mutations.ts";
import type { Runtime } from "./Runtime.ts";

export type FormSubmitOutcome =
  | { readonly _tag: "Received" }
  | {
      readonly _tag: "Rejected";
      readonly propertyId?: C.SpacePropertyId;
      readonly problem: C.SpaceFormAnswerProblem | "unknown_question";
    };

interface FormTarget {
  readonly rootPageId: C.SpacePageId;
  readonly pageId: C.SpacePageId;
  readonly blockId: C.SpaceBlockId;
  readonly viewId: C.SpaceViewId;
}

const formScope = Effect.fn("SharedForms.scope")(function* (target: FormTarget) {
  const scope = yield* resolveView(target.rootPageId, target.pageId, target.blockId, target.viewId);
  if (scope.shape.type !== "form") return yield* notFound("view", target.viewId);
  return scope;
});

/**
 * Anonymous form reads and writes. A submission goes through the ordinary mutation path, so it
 * gets a receipt, bumps the data revision and reaches open clients like any other row.
 */
export const make = (rt: Runtime) => {
  const { admit, read, run } = rt;
  const describeSharedForm = Effect.fn("SpacesService.describeSharedForm")(function* (
    input: FormTarget,
  ) {
    const environmentId = yield* admit();
    return yield* read(environmentId, () => formScope(input).pipe(Effect.map(describeForm)));
  });
  const submitSharedForm = Effect.fn("SpacesService.submitSharedForm")(function* (
    input: FormTarget & {
      readonly shareId: string;
      readonly submissionId: string;
      readonly answers: Readonly<Record<string, Json>>;
    },
  ) {
    const environmentId = yield* admit();
    return yield* run(environmentId, (meta) =>
      Effect.gen(function* () {
        const scope = yield* formScope(input);
        const draft = formDraft(formQuestions(scope), input.answers);
        if (!draft.ok)
          return {
            _tag: "Rejected",
            problem: draft.problem,
            ...(draft.propertyId === undefined ? {} : { propertyId: draft.propertyId }),
          } satisfies FormSubmitOutcome;
        const epoch = yield* Receipts.active(meta);
        if (!epoch) return yield* new C.SpacesUnavailableError({ stage: "storage" });
        const request = yield* validateRaw({
          operation: "createRows",
          input: {
            environmentId,
            mutationId: `form_${input.shareId}_${input.submissionId}`,
            receiptEpoch: epoch.epoch,
            dataSourceId: scope.source.data_source_id,
            rows: [
              { ...(draft.title === undefined ? {} : { title: draft.title }), cells: draft.cells },
            ],
          },
        }).pipe(
          Effect.flatMap(decodeRequest),
          Effect.mapError((e) =>
            isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
          ),
        );
        yield* commitRequest(request, meta, undefined).pipe(
          Effect.catchTags({ SpaceMutationIdMismatchError: () => Effect.void }),
        );
        return { _tag: "Received" } satisfies FormSubmitOutcome;
      }),
    );
  });
  return { describeSharedForm, submitSharedForm };
};
