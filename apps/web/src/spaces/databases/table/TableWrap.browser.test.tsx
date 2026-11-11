import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { FakeDatabase } from "../test/fakeDatabase";
import { readyWhen } from "../test/readyWhen";

import { fixtureView } from "../test/fixtures";
import { mountTable } from "./tableHarness";

const state = vi.hoisted(() => ({ fake: null as unknown }));

vi.mock(import("../data/ports"), async () => {
  const { fakePortsModule } = await import("../test/fakeDatabase");
  return fakePortsModule(() => state.fake as never) as never;
});
vi.mock(import("../../../state/environments"), async (original) => {
  const { environmentWith } = await import("../test/environment");
  return { ...(await original()), useEnvironment: (() => environmentWith(true)) as never };
});
vi.mock(import("../../../state/spaces"), async (original) => ({
  ...(await original()),
  useSpacesAvailability: () => "writable",
}));

async function mount(layout: Record<string, unknown> = {}) {
  const fake = new FakeDatabase({
    rows: 40,
    quietRowWrites: true,
    views: [fixtureView("view-table", "table", "Table", 0, layout)],
  });
  state.fake = fake;
  await page.viewport(1800, 900);
  const table = await readyWhen(await mountTable(fake), (mounted) =>
    vi.waitFor(() => expect(mounted.cell("row-1", "title")).not.toBeNull()),
  );
  return { fake, ...table };
}
const rowHeight = (cell: HTMLElement | null) => cell!.parentElement!.style.height;
const rowTop = (cell: HTMLElement | null) => cell!.parentElement!.style.top;

describe("wrapped cells", () => {
  it("keeps one line per row until a wrap is turned on", async () => {
    const { screen, cell } = await mount();
    await using _screen = screen;
    expect(rowHeight(cell("row-1", "title"))).toBe("34px");
  });

  it("uses the taller row height for every row when the layout wraps all cells", async () => {
    const { screen, cell, grid } = await mount({ wrapCells: true });
    await using _screen = screen;
    expect(rowHeight(cell("row-1", "title"))).toBe("76px");
    expect(rowTop(cell("row-2", "title"))).toBe("76px");
    // The scroll height follows: 40 rows of 76px plus the add row.
    const canvas = grid().querySelector<HTMLElement>('[role="presentation"].relative')!;
    expect(canvas.style.height).toBe(`${40 * 76 + 34}px`);
  });

  it("wraps one column from its header menu and writes the property entry", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Notes", exact: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "Wrap column" }));
    await vi.waitFor(() =>
      expect(fake.callsOf("updateView").at(-1)?.input.properties).toEqual({
        set: { notes: { wrap: true } },
      }),
    );
    await vi.waitFor(() => expect(rowHeight(cell("row-1", "title"))).toBe("76px"));
    await userEvent.click(page.getByRole("button", { name: "Notes", exact: true }));
    await expect.element(page.getByRole("menuitem", { name: "Unwrap column" })).toBeVisible();
  });
});
