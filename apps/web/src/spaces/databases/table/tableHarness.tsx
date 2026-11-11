import { RegistryContext } from "@effect/atom-react";
import { useContext } from "react";
import type { AtomRegistry } from "effect/reactivity";

import { render, type Screen } from "../../../../test/render";
import type { FakeDatabase } from "../test/fakeDatabase";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";
import type { DatabaseBlockHost } from "../blocks/DatabaseBlockHost";

export interface MountedTable {
  readonly screen: Screen;
  readonly host: DatabaseBlockHost;
  /** The registry the table runs in, to bump counters from outside the component. */
  registry(): AtomRegistry.AtomRegistry;
  /** The scroll container; throws until the grid has mounted. */
  grid(): HTMLElement;
  cell(rowId: string, column: string): HTMLElement | null;
}

function RegistryProbe({
  onRegistry,
}: {
  readonly onRegistry: (registry: AtomRegistry.AtomRegistry) => void;
}) {
  onRegistry(useContext(RegistryContext));
  return null;
}

/** A table view over the in-memory fake, as the page document would mount it. */
export async function mountTable(
  _fake: FakeDatabase,
  layout: "inline" | "page" = "page",
): Promise<MountedTable> {
  const { controller } = fakeController();
  const host = testHost(controller);
  let registry: AtomRegistry.AtomRegistry | null = null;
  const screen = await render(
    <>
      <RegistryProbe
        onRegistry={(value) => {
          registry = value;
        }}
      />
      <DatabaseHarness host={host} initialViewIds={["view-table"]} layout={layout} />
    </>,
  );
  const grid = () => {
    const element = screen.container.querySelector<HTMLElement>('[role="grid"]');
    if (element === null) throw new Error("The grid has not mounted");
    return element;
  };
  return {
    screen,
    host,
    registry: () => registry!,
    grid,
    cell: (rowId, column) =>
      screen.container.querySelector<HTMLElement>(`[data-row="${rowId}"][data-col="${column}"]`),
  };
}
