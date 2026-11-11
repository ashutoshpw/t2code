import {
  databaseErrorMessage,
  isoDay,
  knownView,
  newRowCells,
  seedCellsForView,
  templateForNewRow,
  type DatabaseWriter,
} from "@t2code/client-runtime/spaces";
import type { SpaceDataSource, SpaceDatabaseView } from "@t2code/contracts/spaces";
import type { DatabaseMutations } from "@t2code/client-runtime/state/spaces-database-mutations";

type CreateRowsInput = Parameters<DatabaseMutations["createRows"]>[2];

/**
 * One new row for a view: its title, the values the view's filter implies (so it shows up in the
 * view that made it), and the data source's default template when it has one.
 */
export function newRowInput(args: {
  readonly view: SpaceDatabaseView | undefined;
  readonly dataSource: SpaceDataSource;
  readonly title: string;
  readonly now: number;
  readonly zone: string;
}): CreateRowsInput {
  const { view, dataSource } = args;
  const title = args.title.trim();
  const today = isoDay(args.now, args.zone);
  // A calendar or timeline view only lists rows that have a date, so the new row gets today's.
  const cells = {
    ...(view === undefined ? {} : seedCellsForView(knownView(view), dataSource, today)),
    ...newRowCells({ filter: view?.filter, properties: dataSource.properties, today }),
  };
  const templateId = templateForNewRow(dataSource, undefined);
  return {
    dataSourceId: dataSource.id,
    rows: [
      {
        ...(title === "" ? {} : { title }),
        ...(Object.keys(cells).length > 0 ? { cells } : {}),
        ...(templateId === undefined ? {} : { templateId }),
      },
    ],
  };
}

export type AddRowResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export const NO_LONGER_ALLOWED = "You can no longer add rows to this database.";

/** Adds one row: queued cell edits go first so the server sees them in order, then the row. */
export async function addRow(args: {
  readonly environmentId: Parameters<DatabaseMutations["createRows"]>[1];
  readonly registry: Parameters<DatabaseMutations["createRows"]>[0];
  readonly mutations: Pick<DatabaseMutations, "createRows">;
  readonly writer: Pick<DatabaseWriter, "flush" | "track">;
  readonly canWrite: () => boolean;
  readonly view: SpaceDatabaseView | undefined;
  readonly dataSource: SpaceDataSource;
  readonly title: string;
  readonly now: number;
  readonly zone: string;
}): Promise<AddRowResult> {
  if (!args.canWrite()) return { ok: false, message: NO_LONGER_ALLOWED };
  try {
    await args.writer.flush();
    const input = newRowInput(args);
    await args.writer.track(args.dataSource.id, { structural: true }, () =>
      args.mutations.createRows(args.registry, args.environmentId, input),
    );
    return { ok: true };
  } catch (failure) {
    return { ok: false, message: databaseErrorMessage(failure) };
  }
}
