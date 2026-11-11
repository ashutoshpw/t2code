import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { FakeDatabase } from "../test/fakeDatabase";
import { readyWhen } from "../test/readyWhen";

import { fixtureView, subItemRows, withSubItems } from "../test/fixtures";
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

async function mount(layout: Record<string, unknown> = {}, strict = false) {
  const fake = new FakeDatabase({
    quietRowWrites: true,
    dataSource: withSubItems(),
    rowData: subItemRows(),
    views: [fixtureView("view-table", "table", "Table", 0, layout)],
  });
  state.fake = fake;
  await page.viewport(1800, 900);
  const table = await readyWhen(await mountTable(fake, "page", strict), (mounted) =>
    vi.waitFor(() => expect(mounted.cell("row-1", "title")).not.toBeNull()),
  );
  return { fake, ...table };
}
const toggle = () => page.getByRole("button", { name: "Expand sub-items" });

describe("table sub-items", () => {
  it("lists only top-level rows, expands children under their parent and collapses them", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    expect(cell("row-4", "title")).toBeNull();
    const first = fake.callsOf("query")[0]!.input;
    expect(first.scope).toEqual({ parentRowId: null });
    await userEvent.click(toggle());
    await vi.waitFor(() => expect(cell("row-4", "title")).not.toBeNull());
    expect(cell("row-5", "title")).not.toBeNull();
    expect(
      fake
        .callsOf("query")
        .some(
          (call) =>
            (call.input.scope as { parentRowId?: string } | undefined)?.parentRowId === "row-1",
        ),
    ).toBe(true);
    // Children sit under the parent, one level in.
    const parentLeft = cell("row-1", "title")!
      .querySelector("button")!
      .getBoundingClientRect().left;
    const childText = cell("row-4", "title")!.querySelector("span[data-variant]")!;
    expect(childText.getBoundingClientRect().left).toBeGreaterThan(parentLeft + 18);
    await userEvent.click(page.getByRole("button", { name: "Collapse sub-items" }));
    await vi.waitFor(() => expect(cell("row-4", "title")).toBeNull());
  });

  it("still expands after StrictMode re-runs the effect cleanups", async () => {
    const { screen, cell } = await mount({}, true);
    await using _screen = screen;
    await userEvent.click(toggle());
    await vi.waitFor(() => expect(cell("row-4", "title")).not.toBeNull());
  });

  it("expands and collapses with the arrow keys on the title cell", async () => {
    const { screen, cell } = await mount();
    await using _screen = screen;
    cell("row-1", "title")!.focus();
    await userEvent.keyboard("{ArrowRight}");
    await vi.waitFor(() => expect(cell("row-4", "title")).not.toBeNull());
    await userEvent.keyboard("{ArrowLeft}");
    await vi.waitFor(() => expect(cell("row-4", "title")).toBeNull());
    // A row without children moves on to the next cell instead.
    cell("row-2", "title")!.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect((document.activeElement as HTMLElement).dataset.row).toBe("row-2");
    expect((document.activeElement as HTMLElement).dataset.col).not.toBe("title");
  });

  it("creates a sub-item seeded with its parent", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(toggle());
    await userEvent.click(screen.getByRole("button", { name: "New sub-item" }));
    await vi.waitFor(() => expect(fake.callsOf("createRows")).toHaveLength(1));
    expect(fake.callsOf("createRows")[0]!.input.rows).toEqual([{ cells: { parent: ["row-1"] } }]);
    // The refreshed children include the new row, under the still-expanded parent.
    await vi.waitFor(() =>
      expect(
        screen.container.querySelector('[data-row^="row-new"][data-col="title"]'),
      ).not.toBeNull(),
    );
    void cell;
  });

  it("is flat while searching and when the view flattens sub-items", async () => {
    const searching = await mount();
    await using _searching = searching.screen;
    await userEvent.fill(searching.screen.getByRole("searchbox", { name: "Search rows" }), "Task");
    await vi.waitFor(() =>
      expect(searching.fake.callsOf("query").at(-1)?.input.search).toBe("Task"),
    );
    expect(searching.fake.callsOf("query").at(-1)?.input.scope).toBeUndefined();
    await vi.waitFor(() => expect(searching.cell("row-4", "title")).not.toBeNull());
    await expect.element(toggle()).not.toBeInTheDocument();
  });

  it("shows every row when the layout flattens", async () => {
    const { fake, screen, cell } = await mount({ subItems: "flattened" });
    await using _screen = screen;
    await vi.waitFor(() => expect(cell("row-4", "title")).not.toBeNull());
    expect(fake.callsOf("query")[0]!.input.scope).toBeUndefined();
  });
});
