import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act } from "../../../../test/render";
import { FIXTURE_IDS } from "../test/fixtures";
import { FakeDatabase } from "../test/fakeDatabase";
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

async function mount(
  options: ConstructorParameters<typeof FakeDatabase>[0] = { rows: 30 },
  patch?: object,
) {
  const fake = new FakeDatabase({ quietRowWrites: true, ...options });
  if (patch !== undefined)
    fake.views = fake.views.map((view) =>
      view.id === FIXTURE_IDS.tableView ? ({ ...view, ...patch } as typeof view) : view,
    );
  state.fake = fake;
  await page.viewport(1800, 1200);
  const table = await mountTable(fake);
  await vi.waitFor(() => expect(table.grid()).toBeTruthy());
  return { fake, ...table };
}
const locate = (element: HTMLElement | null) => page.elementLocator(element!);
const inGrid = (grid: HTMLElement) => page.elementLocator(grid);

describe("add row", () => {
  it("adds a row, opens its title editor and writes the typed title", async () => {
    const { fake, screen, grid, cell } = await mount({ rows: 3 });
    await using _screen = screen;
    await userEvent.click(inGrid(grid()).getByRole("button", { name: "New" }));
    await vi.waitFor(() => expect(fake.callsOf("createRows")).toHaveLength(1));
    const input = screen.getByRole("textbox", { name: "Name" });
    await expect.element(input).toHaveFocus();
    await userEvent.keyboard("Hello{Enter}");
    await vi.waitFor(() =>
      expect(fake.callsOf("updateRows").at(-1)?.input.rows).toEqual([
        { pageId: "row-new-1", cells: { title: "Hello" } },
      ]),
    );
    expect(cell("row-new-1", "title")?.textContent).toContain("Hello");
  });

  it("prefills the new row from the view filter", async () => {
    const { fake, screen, grid } = await mount(
      { rows: 3 },
      { filter: { and: [{ property: "status", operator: "equals", value: "doing" }] } },
    );
    await using _screen = screen;
    await userEvent.click(inGrid(grid()).getByRole("button", { name: "New" }));
    await vi.waitFor(() => expect(fake.callsOf("createRows")).toHaveLength(1));
    expect(fake.callsOf("createRows")[0]!.input.rows).toEqual([{ cells: { status: "doing" } }]);
  });

  it("is not offered without permission to add rows", async () => {
    const { screen, grid } = await mount({ rows: 3, permissions: { rows: false } });
    await using _screen = screen;
    await expect
      .element(page.elementLocator(grid()).getByRole("button", { name: "New" }))
      .not.toBeInTheDocument();
  });
});

describe("grouped table", () => {
  const grouped = { group: { property: "status" } };

  it("renders group headers with counts, collapses a group and adds into a group", async () => {
    const { fake, screen, grid, cell } = await mount({ rows: 9 }, grouped);
    await using _screen = screen;
    const first = fake.callsOf("query")[0]!.input;
    expect(first).toMatchObject({
      mode: "groups",
      rowsPerGroup: 25,
      group: { property: "status" },
    });
    await expect
      .element(inGrid(grid()).getByRole("button", { name: "Collapse Not started" }))
      .toBeVisible();
    await expect
      .element(inGrid(grid()).getByRole("button", { name: "Collapse Done" }))
      .toBeVisible();
    expect(cell("row-1", "title")).not.toBeNull();

    await userEvent.click(inGrid(grid()).getByRole("button", { name: "Collapse Not started" }));
    await vi.waitFor(() => expect(cell("row-1", "title")).toBeNull());
    await userEvent.click(inGrid(grid()).getByRole("button", { name: "Expand Not started" }));
    await vi.waitFor(() => expect(cell("row-1", "title")).not.toBeNull());

    const adds = inGrid(grid()).getByRole("button", { name: "New" });
    // Order: Not started, In progress, Done, then the empty bucket.
    await userEvent.click(adds.nth(2));
    await vi.waitFor(() => expect(fake.callsOf("createRows")).toHaveLength(1));
    expect(fake.callsOf("createRows")[0]!.input.rows).toEqual([{ cells: { status: "done" } }]);
  });

  it("continues a bucket that has more rows than its preview", async () => {
    const { fake, screen, grid } = await mount({ rows: 90 }, grouped);
    await using _screen = screen;
    await userEvent.click(inGrid(grid()).getByRole("button", { name: "Load more" }).first());
    await vi.waitFor(() =>
      expect(fake.callsOf("query").at(-1)!.input).toMatchObject({
        mode: "rows",
        scope: { group: { kind: "option", optionId: "todo" } },
      }),
    );
  });
});

describe("footer and columns", () => {
  it("shows the total and writes an aggregate to the view", async () => {
    const { fake, screen, grid } = await mount({ rows: 12 });
    await using _screen = screen;
    await expect.element(inGrid(grid()).getByText("Count 12")).toBeVisible();
    await userEvent.click(inGrid(grid()).getByRole("button", { name: "Calculate Notes" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "Count empty" }));
    await vi.waitFor(() => expect(fake.callsOf("updateView")).toHaveLength(1));
    expect(fake.callsOf("updateView")[0]!.input).toMatchObject({
      viewId: "view-table",
      properties: { set: { notes: { aggregate: "empty" } } },
    });
    // The aggregate changes the query: the next window asks for it.
    await vi.waitFor(() =>
      expect(fake.callsOf("query").at(-1)!.input.aggregates).toEqual([
        { property: "notes", function: "empty" },
      ]),
    );
    await expect.element(inGrid(grid()).getByText("Count empty 12")).toBeVisible();
  });

  it("resizes a column and commits one view edit on pointer up", async () => {
    const { fake, screen, grid } = await mount({ rows: 5 });
    await using _screen = screen;
    await userEvent.dragAndDrop(
      page.getByRole("separator", { name: "Resize Notes" }),
      page.getByRole("button", { name: "Amount" }),
    );
    await vi.waitFor(() => expect(fake.callsOf("updateView")).toHaveLength(1));
    const width = (
      fake.callsOf("updateView")[0]!.input as { properties: { set: { notes: { width: number } } } }
    ).properties.set.notes.width;
    expect(width).toBeGreaterThan(200);
    expect(grid().style.getPropertyValue("--col-notes")).toBe(`${width}px`);
  });
});

describe("column order", () => {
  it("reorders a column by dragging its header and commits the full order", async () => {
    const { fake, screen } = await mount({ rows: 3 });
    await using _screen = screen;
    const center = (name: string) => {
      const rect = page.getByRole("button", { name }).element().getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    };
    const from = center("Notes");
    const to = center("Status");
    const pointer = (type: string, at: { x: number; y: number }) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: at.x,
        clientY: at.y,
        pointerId: 1,
        isPrimary: true,
        button: 0,
      });
    page
      .getByRole("button", { name: "Notes" })
      .element()
      .dispatchEvent(pointer("pointerdown", from));
    // dnd-kit tracks the pointer on the document and measures after each move.
    for (let step = 1; step <= 6; step += 1) {
      await act(
        async () =>
          void document.dispatchEvent(
            pointer("pointermove", {
              x: from.x + ((to.x - from.x) * step) / 6,
              y: from.y,
            }),
          ),
      );
    }
    await act(async () => void document.dispatchEvent(pointer("pointerup", to)));
    await vi.waitFor(() => expect(fake.callsOf("updateView")).toHaveLength(1));
    expect(fake.callsOf("updateView")[0]!.input).toMatchObject({
      properties: { order: ["title", "notes", "status", "tags", "due", "done", "amount"] },
    });
  });

  it("does not start a column drag from a press inside the header menu", async () => {
    const { fake, screen } = await mount({ rows: 3 });
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Notes" }));
    const name = page.getByRole("textbox", { name: "Property name" }).element();
    const rect = name.getBoundingClientRect();
    const pointer = (type: string, x: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: rect.y + rect.height / 2,
        pointerId: 1,
        isPrimary: true,
        button: 0,
      });
    name.dispatchEvent(pointer("pointerdown", rect.x + 10));
    for (let step = 1; step <= 6; step += 1)
      await act(
        async () => void document.dispatchEvent(pointer("pointermove", rect.x + 10 + step * 40)),
      );
    await act(async () => void document.dispatchEvent(pointer("pointerup", rect.x + 250)));
    expect(fake.callsOf("updateView")).toHaveLength(0);
    expect(page.getByRole("columnheader", { name: /Notes/ }).element().style.transform).toBe("");
  });
});

describe("rows", () => {
  it("opens a row from its Open button and with Mod+Enter", async () => {
    const { host, screen, cell } = await mount({ rows: 5 });
    await using _screen = screen;
    await userEvent.click(
      page.elementLocator(cell("row-2", "title")!).getByRole("button", { name: "Open row" }),
    );
    expect(host.openPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "row-2" }));
    cell("row-3", "notes")!.focus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(host.openPage).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: "row-3" }));
  });

  it("moves a row to trash from its menu", async () => {
    const { fake, screen, cell } = await mount({ rows: 5 });
    await using _screen = screen;
    await userEvent.click(
      page.elementLocator(cell("row-2", "title")!).getByRole("button", { name: "Row actions" }),
    );
    await userEvent.click(page.getByRole("menuitem", { name: "Delete" }));
    await vi.waitFor(() => expect(fake.callsOf("trashRow")).toHaveLength(1));
    expect(fake.callsOf("trashRow")[0]!.input).toEqual({ pageId: "row-2" });
  });
});

describe("refresh", () => {
  it("shows a change made elsewhere after the data source counter moves", async () => {
    const { fake, registry, screen, cell } = await mount({ rows: 5 });
    await using _screen = screen;
    expect(cell("row-1", "title")?.textContent).toContain("Task 1");
    const queries = fake.callsOf("query").length;
    fake.rows = fake.rows.map((row) =>
      row.page.id === "row-1"
        ? ({ ...row, cells: { ...row.cells, title: "Changed outside" } } as typeof row)
        : row,
    );
    const counter = fake.counter(`dataSource:${FIXTURE_IDS.dataSource}`);
    registry().set(counter, registry().get(counter) + 1);
    await vi.waitFor(() =>
      expect(cell("row-1", "title")?.textContent).toContain("Changed outside"),
    );
    expect(fake.callsOf("query").length).toBeGreaterThan(queries);
    expect(fake.callsOf("query")).toSatisfy((calls: unknown[]) => calls.length === queries + 1);
  });
});

describe("read-only", () => {
  it("renders values but offers no editor, no add row and no new property", async () => {
    const { fake, screen, grid, cell } = await mount({
      rows: 5,
      permissions: { cells: false, rows: false, schema: false, views: false },
    });
    await using _screen = screen;
    await expect
      .element(page.getByRole("separator", { name: "Resize Notes" }))
      .not.toBeInTheDocument();
    expect(cell("row-1", "title")!.getAttribute("aria-readonly")).toBe("true");
    await userEvent.click(locate(cell("row-1", "title")));
    await userEvent.keyboard("{Enter}abc");
    expect(screen.container.querySelectorAll("input")).toHaveLength(1);
    await expect
      .element(inGrid(grid()).getByRole("button", { name: "New" }))
      .not.toBeInTheDocument();
    await expect
      .element(inGrid(grid()).getByRole("button", { name: "Add a property" }))
      .not.toBeInTheDocument();
    cell("row-1", "status")!.focus();
    await userEvent.keyboard("{Backspace}");
    expect(fake.callsOf("updateRows")).toHaveLength(0);
  });
});
