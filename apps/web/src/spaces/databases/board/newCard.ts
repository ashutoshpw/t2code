import type { SpaceCellValue, SpaceDatabaseRow, SpaceGroupKey } from "@t2code/contracts/spaces";

import type { DatabaseActions } from "../data/actions";

/**
 * Creates a card in a column and opens it. The query session is held from before the request:
 * the structural ack would otherwise refresh the loaded cards before the new one is placed.
 */
export async function createCard(input: {
  readonly actions: Pick<DatabaseActions, "createRow" | "openRow">;
  readonly hold: () => () => void;
  readonly placeRow: (row: SpaceDatabaseRow, group: SpaceGroupKey) => void;
  readonly cells: Record<string, SpaceCellValue>;
  readonly key: SpaceGroupKey;
}): Promise<void> {
  const release = input.hold();
  try {
    const row = await input.actions.createRow({ cells: input.cells });
    if (row === null) return;
    input.placeRow(row, input.key);
    input.actions.openRow(row.page.id);
  } finally {
    release();
  }
}
