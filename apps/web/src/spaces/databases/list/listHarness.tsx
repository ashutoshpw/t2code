import type { SpaceDatabaseView } from "@t2code/contracts/spaces";

import { render, type Screen } from "../../../../test/render";
import type { DatabaseBlockHost } from "../blocks/DatabaseBlockHost";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";

export interface MountedRows {
  readonly screen: Screen;
  readonly host: DatabaseBlockHost;
  /** The windowed scroll container around the list. */
  scroller(): HTMLElement;
}

/** A list or gallery view over the in-memory fake, as the page document would mount it. */
export async function mountRows(view: SpaceDatabaseView, editable = true): Promise<MountedRows> {
  const { controller } = fakeController();
  const host = testHost(controller);
  const screen = await render(
    <DatabaseHarness host={host} initialViewIds={[view.id]} layout="page" editable={editable} />,
  );
  return {
    screen,
    host,
    scroller: () => {
      const list = screen.container.querySelector<HTMLElement>('[role="list"]');
      if (list?.parentElement == null) throw new Error("The list has not mounted");
      return list.parentElement;
    },
  };
}
