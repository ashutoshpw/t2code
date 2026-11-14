import { MessageId, ModelSelection, ProjectId, RuntimeMode, ThreadId } from "@t2code/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

const MAX_FANOUT_MODELS = 16;
const MAX_FANOUT_METADATA_BYTES = 65_536;
const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const workspace = {
  routeKey: boundedId,
  projectId: ProjectId,
  branch: boundedId,
  runtimeMode: RuntimeMode,
  startFromOrigin: Schema.Boolean,
};
const FanoutOutcome = Schema.Literals(["not-sent", "uncertain", "accepted", "failed"]);
export type FanoutOutcome = typeof FanoutOutcome.Type;
export const FanoutRecovery = Schema.Struct({
  version: Schema.Literal(1),
  ...workspace,
  attempts: Schema.Array(
    Schema.Struct({
      id: boundedId,
      selection: ModelSelection,
      threadId: ThreadId,
      messageId: MessageId,
      outcome: FanoutOutcome,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_FANOUT_MODELS)),
}).check(
  Schema.makeFilter((value) =>
    [
      value.attempts.map((attempt) => attempt.id),
      value.attempts.map((attempt) => attempt.threadId),
      value.attempts.map((attempt) => attempt.messageId),
      value.attempts.map((attempt) =>
        JSON.stringify([attempt.selection.instanceId, attempt.selection.model]),
      ),
    ].every((ids) => new Set(ids).size === ids.length),
  ),
  Schema.makeFilter(
    (value) =>
      new TextEncoder().encode(
        JSON.stringify({
          ...value,
          attempts: value.attempts.map((attempt) => ({ ...attempt, outcome: "uncertain" })),
        }),
      ).byteLength <= MAX_FANOUT_METADATA_BYTES,
  ),
);
export type FanoutRecovery = typeof FanoutRecovery.Type;
export const FanoutRetry = Schema.Struct({
  ...workspace,
  entryId: boundedId,
  selections: Schema.Array(ModelSelection).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_FANOUT_MODELS),
  ),
  uncertain: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_FANOUT_METADATA_BYTES,
  ),
);
export type FanoutRetry = typeof FanoutRetry.Type;

export const draftFanoutSelectionsAtom = Atom.family((_routeKey: string) =>
  Atom.make<ReadonlyArray<ModelSelection> | null>(null).pipe(Atom.keepAlive),
);

export function fanoutSelectionKey(selection: ModelSelection) {
  return JSON.stringify([
    selection.instanceId,
    selection.model,
    [...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
  ]);
}

export function validateFanoutSelections(selections: ReadonlyArray<ModelSelection>) {
  if (
    !selections.length ||
    selections.length > MAX_FANOUT_MODELS ||
    new TextEncoder().encode(JSON.stringify(selections)).byteLength > MAX_FANOUT_METADATA_BYTES / 2
  )
    throw new Error(
      `Choose between 1 and ${MAX_FANOUT_MODELS} models with bounded options before sending.`,
    );
  const identities = selections.map((selection) =>
    JSON.stringify([selection.instanceId, selection.model]),
  );
  if (new Set(identities).size !== identities.length)
    throw new Error("Choose each provider/model once before sending.");
}

export function assertFanoutRetry(input: {
  retry: FanoutRetry | undefined;
  selections: ReadonlyArray<ModelSelection> | null;
  projectId: ProjectId | undefined;
  branch: string | null;
  runtimeMode: RuntimeMode;
  startFromOrigin: boolean;
}) {
  const { retry } = input;
  if (!retry) return;
  if (
    retry.projectId !== input.projectId ||
    retry.branch !== input.branch ||
    retry.runtimeMode !== input.runtimeMode ||
    retry.startFromOrigin !== input.startFromOrigin ||
    JSON.stringify(input.selections?.map(fanoutSelectionKey)) !==
      JSON.stringify(retry.selections.map(fanoutSelectionKey))
  )
    throw new Error(
      "The recovered model selections or workspace changed. Select the saved values, or start a fresh draft to choose different models.",
    );
}
