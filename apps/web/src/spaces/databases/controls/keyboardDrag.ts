import { expect, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

/**
 * Moves a sortable row with the keyboard. dnd-kit attaches its key listeners a tick after
 * pick-up and applies each move on render, so every step waits for the one before.
 */
export async function dragWithKeyboard(name: string | RegExp, key: string) {
  const handle = page.getByRole("button", { name }).first();
  handle.element().focus();
  await userEvent.keyboard(" ");
  await expect.element(handle).toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard(key);
  await vi.waitFor(() =>
    expect(handle.element().parentElement?.style.transform).not.toMatch(/^translate3d\(0px, 0px/),
  );
  await userEvent.keyboard(" ");
}
