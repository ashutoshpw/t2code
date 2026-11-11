import {
  databaseErrorMessage,
  cellForGroupKey,
  isoDay,
  knownProperty,
  knownView,
  newRowCells,
  seedCellsForView,
  startOfMonth,
  templateForNewRow,
  type DatabaseWriter,
} from "@t2code/client-runtime/spaces";
import {
  SpaceKnownGroupKey,
  type SpaceDataSource,
  type SpaceDatabaseView,
  type SpaceGroupKey,
  type SpacePageId,
} from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";
import type { DatabaseMutations } from "@t2code/client-runtime/state/spaces-database-mutations";

const isKnownGroupKey = Schema.is(SpaceKnownGroupKey);

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
  /** `YYYY-MM-01` of the month a calendar or timeline shows. */
  readonly month?: string;
  /** The section a row is added to in a grouped view; its value is seeded. */
  readonly groupKey?: SpaceGroupKey;
}): CreateRowsInput {
  const { view, dataSource } = args;
  const title = args.title.trim();
  const today = isoDay(args.now, args.zone);
  // A calendar or timeline lists only rows dated in the viewed month: today when that is the
  // month on screen, else the month's first day.
  const seedDay =
    args.month === undefined || startOfMonth(today) === args.month ? today : args.month;
  const group =
    view?.group !== undefined && args.groupKey !== undefined && isKnownGroupKey(args.groupKey)
      ? { property: view.group.property, key: args.groupKey }
      : undefined;
  const cells = {
    ...(view === undefined ? {} : seedCellsForView(knownView(view), dataSource, seedDay)),
    ...newRowCells({
      filter: view?.filter,
      properties: dataSource.properties,
      today,
      ...(group === undefined ? {} : { group }),
    }),
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

/** Whether a section of a grouped view can seed its value into a new row. */
export function canAddToGroup(
  view: SpaceDatabaseView,
  dataSource: SpaceDataSource,
  key: SpaceGroupKey,
): boolean {
  if (view.group === undefined || !isKnownGroupKey(key)) return false;
  const property = dataSource.properties[view.group.property];
  const known = property === undefined ? null : knownProperty(property);
  return known !== null && cellForGroupKey(key, known) !== undefined;
}

/** The empty section is not on screen, so a row added without a section would vanish from view. */
export const emptyGroupHidden = (view: SpaceDatabaseView): boolean =>
  view.group !== undefined &&
  (view.group.hideEmpty === true || (view.group.hidden ?? []).some((key) => key.kind === "empty"));

export type AddRowResult =
  | { readonly ok: true; readonly pageId: SpacePageId | undefined }
  | { readonly ok: false; readonly message: string };

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
  readonly month?: string;
  readonly groupKey?: SpaceGroupKey;
}): Promise<AddRowResult> {
  if (!args.canWrite()) return { ok: false, message: NO_LONGER_ALLOWED };
  try {
    await args.writer.flush();
    const input = newRowInput(args);
    const created = await args.writer.track(args.dataSource.id, { structural: true }, () =>
      args.mutations.createRows(args.registry, args.environmentId, input),
    );
    return { ok: true, pageId: created.rows[0]?.pageId };
  } catch (failure) {
    return { ok: false, message: databaseErrorMessage(failure) };
  }
}
