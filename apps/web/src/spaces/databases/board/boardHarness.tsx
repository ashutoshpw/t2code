import { render, type Screen } from "../../../../test/render";
import type { FakeDatabase } from "../test/fakeDatabase";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";
import type { DatabaseBlockHost } from "../blocks/DatabaseBlockHost";

export interface MountedBoard {
  readonly screen: Screen;
  readonly host: DatabaseBlockHost;
  column(name: string): HTMLElement;
  card(rowId: string): HTMLElement | null;
  /** Page ids of the cards in a column, in order. */
  cardsIn(name: string): ReadonlyArray<string>;
}

/** A board view over the in-memory fake, as the page document would mount it. */
export async function mountBoard(
  _fake: FakeDatabase,
  viewId = "view-board",
): Promise<MountedBoard> {
  const { controller } = fakeController();
  const host = testHost(controller);
  const screen = await render(
    <DatabaseHarness host={host} initialViewIds={[viewId]} layout="page" />,
  );
  const column = (name: string) => {
    const element = screen.container.querySelector<HTMLElement>(
      `[data-column-id][aria-label="${name}"]`,
    );
    if (element === null) throw new Error(`No column ${name}`);
    return element;
  };
  return {
    screen,
    host,
    column,
    card: (rowId) => screen.container.querySelector<HTMLElement>(`[data-card-id="${rowId}"]`),
    cardsIn: (name) =>
      [...column(name).querySelectorAll<HTMLElement>("[data-card-id]")].map(
        (card) => card.dataset.cardId!,
      ),
  };
}
