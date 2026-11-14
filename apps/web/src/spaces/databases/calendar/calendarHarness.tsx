import type { SpaceDatabaseRow, SpaceDatabaseView } from "@t2code/contracts/spaces";
import { expect, vi } from "vite-plus/test";

import { render, type Screen } from "../../../../test/render";
import type { DatabaseBlockHost } from "../blocks/DatabaseBlockHost";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";

const iso = "2026-01-01T00:00:00.000Z";

/** A row with a title and, when given, a value in the `due` date property. */
export const datedRow = (id: string, title: string, due?: unknown): SpaceDatabaseRow =>
  ({
    page: { id, title, revision: 1, createdAt: iso, updatedAt: iso },
    number: 1,
    cells: { title, ...(due === undefined ? {} : { due }) },
  }) as unknown as SpaceDatabaseRow;

export interface MountedView {
  readonly screen: Screen;
  readonly host: DatabaseBlockHost;
  readonly root: HTMLElement;
}

/** A calendar or timeline view over the in-memory fake, as the page document would mount it. */
export async function mountDated(view: SpaceDatabaseView, editable = true): Promise<MountedView> {
  const { controller } = fakeController();
  const host = testHost(controller);
  const screen = await render(
    <DatabaseHarness host={host} initialViewIds={[view.id]} layout="page" editable={editable} />,
  );
  return { screen, host, root: screen.container };
}

const center = (element: Element) => {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
};
const pointer = (type: string, point: { x: number; y: number }, buttons: number) =>
  new PointerEvent(type, {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons,
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
  });

/**
 * A dnd-kit pointer drag from one element to another: press, move past the activation distance,
 * wait for the overlay, hover the target, release. Waits on rendered state, never on frames.
 */
export async function dragBetween(source: Element, target: Element, over: () => boolean) {
  const from = center(source);
  const to = center(target);
  source.dispatchEvent(pointer("pointerdown", from, 1));
  document.dispatchEvent(pointer("pointermove", { x: from.x + 8, y: from.y + 8 }, 1));
  await vi.waitFor(() => expect(document.querySelector("[data-dnd-active]")).not.toBeNull());
  document.dispatchEvent(pointer("pointermove", to, 1));
  await vi.waitFor(() => expect(over()).toBe(true));
  document.dispatchEvent(pointer("pointerup", to, 0));
}
