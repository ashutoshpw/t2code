import {
  databaseErrorMessage,
  formRowDraft,
  type DatabaseWriter,
  type FormAnswers,
  type FormQuestionModel,
} from "@t2code/client-runtime/spaces";
import type { DatabaseMutations } from "@t2code/client-runtime/state/spaces-database-mutations";
import type { SpaceDataSource } from "@t2code/contracts/spaces";

import { NO_LONGER_ALLOWED, type AddRowResult } from "./addRow";

/** One row from a filled form: the answers only, no template. Queued cell edits go first. */
export async function submitFormResponse(args: {
  readonly environmentId: Parameters<DatabaseMutations["createRows"]>[1];
  readonly registry: Parameters<DatabaseMutations["createRows"]>[0];
  readonly mutations: Pick<DatabaseMutations, "createRows">;
  readonly writer: Pick<DatabaseWriter, "flush" | "track">;
  readonly canWrite: () => boolean;
  readonly dataSource: SpaceDataSource;
  readonly questions: ReadonlyArray<FormQuestionModel>;
  readonly answers: FormAnswers;
}): Promise<AddRowResult> {
  if (!args.canWrite()) return { ok: false, message: NO_LONGER_ALLOWED };
  try {
    await args.writer.flush();
    const { title, ...cells } = formRowDraft(args.questions, args.answers).cells;
    const input = {
      dataSourceId: args.dataSource.id,
      rows: [
        {
          ...(typeof title === "string" && title !== "" ? { title } : {}),
          ...(Object.keys(cells).length > 0 ? { cells } : {}),
        },
      ],
    };
    const created = await args.writer.track(args.dataSource.id, { structural: true }, () =>
      args.mutations.createRows(args.registry, args.environmentId, input),
    );
    return { ok: true, pageId: created.rows[0]?.pageId };
  } catch (failure) {
    return { ok: false, message: databaseErrorMessage(failure) };
  }
}
